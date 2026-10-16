import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JOB_SORT_FIELDS, JobListQuerySchema } from "../src/contracts.js";
import { createRetainedDatabase, openDatabase } from "../src/db.js";
import { jobQueryMetrics, jobQuerySelection } from "../src/job-list-query.js";
import { listJobs, matchingJobKeys } from "../src/read-model.js";
import { hasExactV14SchemaManifest } from "../src/schema-manifest.js";
import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()?.();
});
const id = (i: number) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
function seed(count = 12) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-query-index-"));
  const dbPath = path.join(directory, "jobctrl.db");
  initializeExactDatabase(dbPath);
  const db = openDatabase(dbPath);
  db.pragma("journal_mode = WAL");
  cleanups.push(() => { if (db.open) db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO resume_templates
    (tenant_id, template_id, display_name, status, built_in, created_at, updated_at)
    VALUES ('local', 'built_in:modern-html', 'Modern HTML', 'active', 1, '2026-01-01', '2026-01-01')`).run();
  db.prepare(`INSERT INTO resume_template_versions
    (tenant_id, version_id, template_id, version_number, display_name, status, theme_json, layout_json, content_hash, created_at)
    VALUES ('local', 'built_in:modern-html:v1', 'built_in:modern-html', 1, 'Modern HTML', 'active', ?, '{}', 'synthetic', '2026-01-01')`)
    .run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME));
  const insert = db.prepare(`INSERT INTO jobs (tenant_id, job_id, url, title, company, location, site, discovered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01')`);
  for (let i = 0; i < count; i++) insert.run("local", id(i), `https://synthetic.invalid/${i}`, `Needle ${i}`, "Équipe", "  Remote  ", "board%_\\");
  insert.run("other", id(0), "https://synthetic.invalid/other", "Other tenant", "Other", "", "");
  return { db, dbPath, directory };
}
const query = (input: Record<string, unknown> = {}) => JobListQuerySchema.parse({ deleted: "all", pageSize: 3, ...input });

describe("SQLite job query index", () => {
  it("hydrates only the selected page and bounds availability/template reads on every arm", () => {
    const { db } = seed(60);
    const original = db.prepare.bind(db);
    const hydrated: string[] = [], availability: string[] = [], templates: string[] = [];
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = original(sql);
      const kind = sql.startsWith("SELECT job_list_projections.*") ? hydrated
        : sql.includes("entity_kind = 'posting_availability'") ? availability
          : sql.includes("FROM job_resume_template_assignments") ? templates : null;
      if (kind) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementation((...args: unknown[]) => {
          kind.push(String(args[1]));
          return get(...args);
        });
      }
      return statement;
    }) as typeof db.prepare);
    for (const sort of JOB_SORT_FIELDS) for (const dir of ["asc", "desc"]) for (const q of ["", "Needle", "Missing"]) {
      hydrated.length = availability.length = templates.length = 0;
      const result = listJobs(db, query({ sort, dir, q, page: 999 }));
      const selected = result.items.map((job) => job.jobKey);
      expect(hydrated).toEqual(selected);
      expect(availability).toEqual(selected);
      expect(templates).toEqual(selected);
      expect(hydrated.length).toBeLessThanOrEqual(3);
      expect(jobQueryMetrics(db).selectedRows).toBe(selected.length);
    }
    expect(jobQueryMetrics(db).refreshes).toBe(1);
    expect(jobQueryMetrics(db).indexedRows).toBe(60);
    expect(hasExactV14SchemaManifest(db)).toBe(true);
  });

  it("uses indexed locale ordinals, canonical tenant joins and trigram membership in SQL", () => {
    const { db } = seed();
    listJobs(db, query());
    const selection = jobQuerySelection(query({ q: "Needle", sort: "company", stage: "discover" }), { where: " WHERE job_list_projections.tenant_id = ?", params: ["local"] });
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT qi.job_id FROM ${selection.pageFrom}${selection.where} ORDER BY ${selection.order} LIMIT 3`)
      .all(...selection.params) as { detail: string }[];
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("job_query_company_DESC");
    expect(details).toContain("PRIMARY KEY (tenant_id=? AND gram=? AND job_id=?)");
    expect(details).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    console.info("job query EXPLAIN", JSON.stringify(plan));
    const countPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM ${selection.from}${selection.where} AND job_list_projections.current_stage = ?`)
      .all(...selection.params, "discover") as { detail: string }[];
    expect(countPlan.map((row) => row.detail).join("\n")).toContain("idx_job_list_projections_stage_state");
    console.info("job query count EXPLAIN", JSON.stringify(countPlan));
    expect(listJobs(db, query({ q: "Other tenant" })).pagination.total).toBe(0);
  });

  it("selects all-matching IDs without hydration and treats empty application timestamps as absent", () => {
    const { db } = seed(4);
    listJobs(db, query());
    for (const [index, [appliedAt, status]] of [
      [null, null], ["", ""], ["", "ApPlIeD"], ["2026-01-01", null],
    ].entries()) {
      db.prepare("UPDATE job_list_projections SET applied_at=?, apply_status=? WHERE tenant_id='local' AND job_id=?")
        .run(appliedAt, status, id(index));
    }
    const original = db.prepare.bind(db);
    const hydrated: string[] = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.startsWith("SELECT job_list_projections.*")
        || sql.includes("entity_kind = 'posting_availability'")
        || sql.includes("FROM job_resume_template_assignments")) hydrated.push(sql);
      return original(sql);
    }) as typeof db.prepare);
    for (const q of ["", "Needle", "Missing"]) {
      expect(matchingJobKeys(db, { applyStatus: "applied", q, deleted: "all" }).sort())
        .toEqual(q === "Missing" ? [] : [id(2), id(3)]);
    }
    expect(hydrated).toEqual([]);
    spy.mockRestore();
    for (const sort of JOB_SORT_FIELDS) for (const q of ["", "Needle"]) {
      expect(listJobs(db, query({ applyStatus: "applied", sort, q, pageSize: 10 })).items
        .map((job) => job.jobKey).sort()).toEqual([id(2), id(3)]);
    }
  });

  it("preserves literal short/Unicode/wildcard searches and summary defaults without field bridging", () => {
    const { db } = seed(3);
    listJobs(db, query());
    db.prepare("UPDATE job_list_projections SET title = '', employer = '', source = '', location = '  Remote  ' WHERE tenant_id='local' AND job_id = ?").run(id(0));
    db.prepare("UPDATE job_list_projections SET title = '😀Équipe%_\\', employer = 'Suffix', location = '  Mars  ' WHERE tenant_id='local' AND job_id = ?").run(id(1));
    for (const [q, expected] of [["Untitled", [id(0)]], ["Unknown company", [id(0)]], ["unknown", [id(0)]],
      ["😀éq", [id(1)]], ["%_\\", [id(1), id(2)]], ["😀", [id(1)]], ["é", [id(1), id(2)]],
      ["e Mars", []], ["Suffix😀", []]] as const) {
      const result = listJobs(db, query({ q, pageSize: 20, sort: "fit_score", dir: "asc" }));
      expect(result.items.map((job) => job.jobKey), q).toEqual(expected);
    }
    expect(listJobs(db, query({ source: "%_\\" })).pagination.total).toBe(2);
    expect(listJobs(db, query({ company: "Unknown company" })).items.map((job) => job.jobKey)).toEqual([id(0)]);
  });

  it("detects both connection-local and external writes, deletion, and restart", () => {
    const { db, dbPath } = seed();
    listJobs(db, query());
    expect(jobQueryMetrics(db).refreshes).toBe(1);
    db.prepare("UPDATE job_list_projections SET title = 'Local changed' WHERE tenant_id='local' AND job_id = ?").run(id(0));
    expect(listJobs(db, query({ q: "Local changed" })).items.map((job) => job.jobKey)).toEqual([id(0)]);
    const writer = new Database(dbPath);
    writer.pragma("foreign_keys = ON");
    cleanups.push(() => { writer.close(); });
    writer.prepare("UPDATE job_list_projections SET title = 'External changed' WHERE tenant_id='local' AND job_id = ?").run(id(0));
    expect(listJobs(db, query({ q: "External changed" })).pagination.total).toBe(1);
    writer.prepare("DELETE FROM jobs WHERE tenant_id='local' AND job_id = ?").run(id(0));
    expect(listJobs(db, query({ q: "External changed" })).pagination.total).toBe(0);
    expect(listJobs(db, query()).pagination.total).toBe(11);
    const reopened = openDatabase(dbPath);
    cleanups.push(() => { reopened.close(); });
    expect(listJobs(reopened, query())).toEqual(listJobs(db, query()));
    expect(jobQueryMetrics(reopened).refreshes).toBe(1);
  });

  it("binds cache freshness to the snapshot established at the data-version boundary", () => {
    const { db, dbPath } = seed();
    listJobs(db, query());
    const writer = new Database(dbPath);
    cleanups.push(() => { writer.close(); });
    const pragma = db.pragma.bind(db);
    let injected = false;
    const pragmaSpy = vi.spyOn(db, "pragma").mockImplementation(((source: string, options: unknown) => {
      const result = pragma(source, options as never);
      if (!injected && source === "data_version" && db.inTransaction) {
        injected = true;
        writer.prepare("UPDATE job_list_projections SET title='Boundary committed' WHERE tenant_id='local' AND job_id=?").run(id(0));
      }
      return result;
    }) as typeof db.pragma);
    const original = db.prepare.bind(db);
    let snapshotTitle: unknown;
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = original(sql);
      if (sql.startsWith("SELECT COUNT(*) AS count FROM ") && sql.includes("temp.job_query_rows qi")) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementation((...args: unknown[]) => {
          const result = get(...args);
          snapshotTitle = (original("SELECT title FROM job_list_projections WHERE tenant_id='local' AND job_id=?").get(id(0)) as { title: string }).title;
          return result;
        });
      }
      return statement;
    }) as typeof db.prepare);
    const result = listJobs(db, query({ q: "Boundary committed" }));
    console.info("snapshot boundary", JSON.stringify({ snapshotTitle, total: result.pagination.total, injected }));
    expect(injected).toBe(true);
    expect(result.pagination.total).toBe(snapshotTitle === "Boundary committed" ? 1 : 0);
    pragmaSpy.mockRestore();
    prepareSpy.mockRestore();
    expect(listJobs(db, query({ q: "Boundary committed" })).pagination.total).toBe(1);
  });

  it("refreshes canonical source provenance and preserves source/company distinctions", () => {
    const { db } = seed(2);
    listJobs(db, query());
    db.prepare(`INSERT INTO job_source_observations (tenant_id, source_observation_id, job_id, source_id,
      source_native_id, observed_url, normalized_observed_url, observed_at)
      VALUES ('local', 'observation', ?, 'Observed%_Équipe', 'synthetic', 'https://synthetic.invalid/0',
        'https://synthetic.invalid/0', '2026-01-02')`).run(id(0));
    db.prepare(`INSERT INTO job_canonical_identities (tenant_id, job_id, canonical_url, ats_kind,
      source_native_id, confidence, resolved_at)
      VALUES ('local', ?, 'https://boards.greenhouse.io/Example/jobs/123', 'greenhouse', '123', 1, '2026-01-02')`).run(id(0));
    for (const source of ["observed%_équipe", "greenhouse:example", "boards.greenhouse.io", "board%_\\"]) {
      const result = listJobs(db, query({ source, sort: "source" }));
      expect(result.items.some((job) => job.jobKey === id(0)), source).toBe(true);
      expect(matchingJobKeys(db, { source, deleted: "all" })).toContain(id(0));
      expect(listJobs(db, query({ company: source })).pagination.total).toBe(0);
    }
    db.prepare("UPDATE job_canonical_identities SET ats_kind='other' WHERE tenant_id='local' AND job_id=?").run(id(0));
    expect(listJobs(db, query({ q: "greenhouse:example" })).pagination.total).toBe(0);
    expect(listJobs(db, query({ source: "boards.greenhouse.io" })).items.map((job) => job.jobKey)).toEqual([id(0)]);
  });

  it("orders compensation range, status, confidence and warning fallbacks in both directions", () => {
    const { db } = seed(8);
    const base = listJobs(db, query()).items[0]!.compensationSummary!;
    const posted = [null, -2, -3, -4, -1, 40_000, 50_000, 60_000];
    const market = [null, -4, -3, -2, -1, 100_000, 120_000, 110_000];
    const confidence = [null, 0.3, 0, 0.9, 0.62, 0.8, 0.62, 0.9];
    const makeRange = (index: number, amount: number) => ({
      currency: index === 6 ? "USD" : "EUR", period: index === 7 ? "month" : "year", component: "base_salary",
      minimumAmount: index === 7 ? 1 : amount, maximumAmount: index === 7 ? 2 : amount + 30_000,
      annualizedMinimumAmount: index === 7 ? amount : null,
      annualizedMaximumAmount: index === 7 ? amount + 30_000 : null,
      annualizedMinimumEur: index === 6 ? amount : null,
      annualizedMaximumEur: index === 6 ? amount + 30_000 : null,
      displayRange: "Synthetic range",
    } as const);
    for (let i = 0; i < 8; i++) {
      const summary = structuredClone(base);
      summary.legacyRawSalary = "";
      summary.warningCount = i % 3;
      summary.posted = { ...summary.posted, range: i < 5 ? null : makeRange(i, posted[i]!),
        displayRange: i === 4 ? "Legacy display" : null,
        parseState: ([null, "ambiguous", "unparseable", "missing", null, "parsed_range", "parsed_range", "parsed_range"] as const)[i]! };
      summary.market = { ...summary.market, range: i < 5 ? null : makeRange(i, market[i]!),
        recordStatus: i === 0 ? "not_requested" : "recorded",
        estimateState: (["not_requested", "unsupported", "source_unavailable", "insufficient_evidence", "estimated_range", "estimated_range", "estimated_range", "estimated_range"] as const)[i]!,
        confidenceScore: i === 5 ? 0.8 : null,
        confidenceBand: (["none", "low", "none", "high", "medium", "high", "medium", "high"] as const)[i]! };
      db.prepare("UPDATE job_list_projections SET salary='', compensation_summary_json=? WHERE tenant_id='local' AND job_id=?")
        .run(JSON.stringify(summary), id(i));
    }
    for (const sort of JOB_SORT_FIELDS.filter((field) => field.startsWith("compensation_"))) {
      const values = sort === "compensation_posted" ? posted : sort === "compensation_market" ? market
        : sort === "compensation_confidence" ? confidence : sort === "compensation_warnings" ? Array.from({ length: 8 }, (_, i) => i % 3)
          : Array.from({ length: 8 }, (_, i) => i < 5 ? null : posted[i]! + (sort === "compensation_max_eur" ? 30_000 : 0));
      for (const dir of ["asc", "desc"] as const) for (const q of ["", "Needle"]) {
        const order = Array.from({ length: 8 }, (_, i) => i).sort((a, b) => {
          const left = values[a] ?? -Infinity, right = values[b] ?? -Infinity;
          return (left < right ? -1 : left > right ? 1 : 0) * (dir === "asc" ? 1 : -1) || a - b;
        }).map(id);
        const traversal = [1, 2, 3].flatMap((page) => listJobs(db, query({ sort, dir, q, page })).items.map((job) => job.jobKey));
        expect(traversal, `${sort} ${dir} ${q}`).toEqual(order);
      }
    }
  });

  it("rolls back a failed refresh without publishing its marker or changing canonical data", () => {
    const { db } = seed();
    listJobs(db, query());
    const accepted = db.prepare("SELECT * FROM temp.job_query_rows ORDER BY job_id").all();
    const marker = db.prepare("SELECT * FROM temp.job_query_meta").get();
    db.prepare("UPDATE job_list_projections SET title = 'New needle' WHERE tenant_id='local' AND job_id = ?").run(id(0));
    const canonical = db.prepare("SELECT * FROM job_list_projections ORDER BY tenant_id, job_id").all();
    const original = db.prepare.bind(db);
    let inserts = 0;
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = original(sql);
      if (sql.startsWith("INSERT INTO temp.job_query_rows")) {
        const run = statement.run.bind(statement);
        vi.spyOn(statement, "run").mockImplementation((...args: unknown[]) => {
          if (++inserts === 3) throw new Error("synthetic index refresh failure");
          return run(...args);
        });
      }
      return statement;
    }) as typeof db.prepare);
    expect(() => listJobs(db, query({ q: "New needle" }))).toThrow("synthetic index refresh failure");
    expect(db.inTransaction).toBe(false);
    expect(db.prepare("SELECT * FROM temp.job_query_meta").get()).toEqual(marker);
    expect(db.prepare("SELECT * FROM temp.job_query_rows ORDER BY job_id").all()).toEqual(accepted);
    expect(db.prepare("SELECT * FROM job_list_projections ORDER BY tenant_id, job_id").all()).toEqual(canonical);
    spy.mockRestore();
    expect(listJobs(db, query({ q: "New needle" })).items.map((job) => job.jobKey)).toEqual([id(0)]);
    expect(listJobs(db, query({ q: "Needle 0" })).pagination.total).toBe(0);
  });

  it("discards TEMP initialization when the first build fails and recovers on retry", () => {
    const { db } = seed();
    const original = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.startsWith("INSERT INTO temp.job_query_rows")) throw new Error("synthetic cold build failure");
      return original(sql);
    }) as typeof db.prepare);
    expect(() => listJobs(db, query())).toThrow("synthetic cold build failure");
    expect(db.inTransaction).toBe(false);
    expect(db.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'job_query_%'").all()).toEqual([]);
    expect(hasExactV14SchemaManifest(db)).toBe(true);
    spy.mockRestore();
    expect(listJobs(db, query()).pagination.total).toBe(12);
  });

  it("cannot publish an index built in a caller's older snapshot or rolled-back transaction", () => {
    const { db, dbPath } = seed();
    listJobs(db, query());
    const writer = new Database(dbPath);
    cleanups.push(() => { writer.close(); });
    db.transaction(() => {
      db.prepare("SELECT COUNT(*) FROM jobs").get();
      writer.prepare("UPDATE job_list_projections SET title = 'Later committed' WHERE tenant_id='local' AND job_id = ?").run(id(0));
      // The projection owner may need a derived write even on a no-op fold.
      // SQLite refuses upgrading an older WAL snapshot; no fresh marker escapes.
      expect(() => listJobs(db, query())).toThrow(/locked/);
    })();
    expect(listJobs(db, query({ q: "Later committed" })).pagination.total).toBe(1);
    expect(() => db.transaction(() => {
      db.prepare("UPDATE job_list_projections SET title = 'Rolled back' WHERE tenant_id='local' AND job_id = ?").run(id(0));
      expect(listJobs(db, query({ q: "Rolled back" })).pagination.total).toBe(1);
      throw new Error("caller rollback");
    })()).toThrow("caller rollback");
    expect(listJobs(db, query({ q: "Rolled back" })).pagination.total).toBe(0);
    expect(matchingJobKeys(db, { q: "Later committed", deleted: "all" })).toEqual([id(0)]);
    db.transaction(() => listJobs(db, query()))();
    writer.prepare("UPDATE job_list_projections SET title = 'Between callers' WHERE tenant_id='local' AND job_id = ?").run(id(0));
    expect(db.transaction(() => listJobs(db, query({ q: "Between callers" })))().pagination.total).toBe(1);
  });

  it("keeps canonical empty/null discovery timestamps ordered by JobId across filtered pages", async () => {
    const { db } = seed(4);
    for (const [i, value] of [null, "", null, null].entries()) {
      db.prepare("UPDATE jobs SET discovered_at=?, company=? WHERE tenant_id='local' AND job_id=?")
        .run(value, i === 0 || i === 2 ? "Keep" : "Drop", id(i));
    }
    const adapterUrl = new URL("../../web/src/contexts/operations/jobsListQuery.ts", import.meta.url).href;
    const { fetchJobsList } = await import(adapterUrl);
    const api = { jobs: async (input: Record<string, unknown>) => listJobs(db, JobListQuerySchema.parse(input)) };
    for (const dir of ["asc", "desc"]) for (const q of ["", "Needle"]) for (const page of [1, 2, 999]) {
      const input = query({ company: "Keep", sort: "discovered_at", dir, q, pageSize: 1, page });
      const direct = listJobs(db, input);
      expect(direct.items.map((job) => job.jobKey)).toEqual([id(page === 1 ? 0 : 2)]);
      expect(await fetchJobsList(api, input)).toEqual(direct);
    }
    expect(db.prepare("SELECT DISTINCT discovered_at FROM job_list_projections WHERE tenant_id='local'").all())
      .toEqual([{ discovered_at: null }]);
  });

  it("closes retained resources and re-admits replacement files against exact v14", () => {
    const { dbPath, directory } = seed();
    const owner = createRetainedDatabase(dbPath);
    cleanups.push(owner.close);
    const first = owner.open();
    listJobs(first, query());
    expect(owner.open()).toBe(first);
    const replacement = path.join(directory, "replacement.db");
    initializeExactDatabase(replacement);
    // Close the seed writer and checkpoint before replacing a synthetic file.
    const checkpoint = new Database(dbPath);
    checkpoint.pragma("wal_checkpoint(TRUNCATE)");
    checkpoint.close();
    fs.renameSync(replacement, dbPath);
    const next = owner.open();
    expect(next).not.toBe(first);
    expect(first.open).toBe(false);
    expect(listJobs(next, query()).pagination.total).toBe(0);
    fs.rmSync(dbPath);
    expect(() => owner.open()).toThrow();
    expect(next.open).toBe(false);
    initializeExactDatabase(dbPath);
    expect(hasExactV14SchemaManifest(owner.open())).toBe(true);
    const invalid = new Database(dbPath);
    invalid.exec("CREATE TABLE forbidden_extra(value TEXT)");
    invalid.close();
    expect(() => owner.open()).toThrow("exact v14");
  });

  it("keeps the HTTP query connection until app close", async () => {
    const { dbPath, directory } = seed();
    const app = buildApp({ dbPath, appDir: directory, configPath: path.join(directory, "config.json") });
    cleanups.push(() => app.close());
    const close = vi.spyOn(Database.prototype, "close");
    const first = await app.inject({ method: "GET", url: "/v1/jobs?q=Needle&pageSize=2" });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(2);
    const afterFirst = close.mock.calls.length;
    expect((await app.inject({ method: "GET", url: "/v1/jobs?q=Needle&pageSize=2" })).json()).toEqual(first.json());
    expect(close.mock.calls.length).toBe(afterFirst);
    await app.close();
    expect(close.mock.calls.length).toBe(afterFirst + 1);
  });
});
