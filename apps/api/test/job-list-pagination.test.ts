import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobCtrlApiClient } from "@jobctrl/api-client";
import {
  BulkJobMutationFilterSchema, JOB_SORT_FIELDS, JobListQuerySchema, JobStagesFilterSchema, STAGES,
  type JobCompensationSummary, type JobListQuery, type JobSortField, type Stage,
} from "../src/contracts.js";
import { listJobs, matchingJobKeys } from "../src/read-model.js";
import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
import { initializeExactDatabase } from "./exact-schema.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()?.();
});

// Expectations are defined from seed inputs, never from a production filter,
// comparator, paginator, or a captured response.
function fixtureRow(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    stage: (index % 2 ? "apply" : "discover") as Stage,
    substage: index % 2 ? "apply" : "discover",
    state: index % 4 === 0 ? "failed" : "pending",
    visibility: index % 12 === 0 ? "hidden" : index % 12 === 1 ? "deleted" : index % 12 === 2 ? "closed" : "active",
    title: index % 3 ? "Platform" : "Needle",
    company: index % 3 ? "Beta" : "Acme",
    source: index % 3 ? "board-b" : "board-a",
    location: index % 3 ? "Madrid" : "Remote",
    fit: index % 10 + 1,
    discovered: `2026-01-${String(Math.floor(index / 4) + 1).padStart(2, "0")}T00:00:00.000Z`,
    scored: `2026-02-${String(12 - Math.floor(index / 4)).padStart(2, "0")}T00:00:00.000Z`,
    applied: index % 5 === 0,
    keyword: index % 3 ? "cloud" : "react",
  };
}
type FixtureRow = ReturnType<typeof fixtureRow>;

function seed(count = 48) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-combined-pages-"));
  const dbPath = path.join(directory, "jobs.db");
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  cleanups.push(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const rows = Array.from({ length: count }, (_, index) => fixtureRow(index));
  db.transaction(() => {
    db.prepare(`INSERT INTO resume_templates
      (tenant_id, template_id, display_name, status, built_in, created_at, updated_at)
      VALUES ('local', 'built_in:modern-html', 'Modern HTML', 'active', 1, '2026-01-01', '2026-01-01')`).run();
    db.prepare(`INSERT INTO resume_template_versions
      (tenant_id, version_id, template_id, version_number, display_name, status, theme_json, layout_json, content_hash, created_at)
      VALUES ('local', 'built_in:modern-html:v1', 'built_in:modern-html', 1, 'Modern HTML', 'active', ?, '{}', 'synthetic', '2026-01-01')`)
      .run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME));
    for (const row of rows) {
      db.prepare(`INSERT INTO jobs (tenant_id, job_id, url, title, company, location, site, discovered_at, salary)
        VALUES ('local', ?, ?, ?, ?, ?, ?, ?, 'EUR 70000')`)
        .run(row.id, `https://synthetic.invalid/${row.id}`, row.title, row.company, row.location, row.source, row.discovered);
      db.prepare(`INSERT INTO job_scores (tenant_id, job_id, version, fit_score, breakdown_json, keywords_json, scored_at)
        VALUES ('local', ?, 1, ?, '{}', '[]', ?)`)
        .run(row.id, row.fit, row.scored);
      db.prepare(`INSERT INTO job_score_keywords
        (tenant_id, job_id, score_version, normalized_keyword, display_keyword, position)
        VALUES ('local', ?, 1, ?, ?, 0)`).run(row.id, row.keyword, row.keyword);
      for (const stage of STAGES) {
        const state = STAGES.indexOf(stage) < STAGES.indexOf(row.substage as Stage) ? "succeeded" : row.state;
        db.prepare(`INSERT INTO job_stage_states (tenant_id, job_id, stage, state, updated_at, version)
          VALUES ('local', ?, ?, ?, ?, 1)`).run(row.id, stage, state, row.scored);
      }
      if (row.visibility === "hidden") {
        db.prepare(`INSERT INTO jobctrl_hidden_jobs (tenant_id, job_id, hidden_at) VALUES ('local', ?, ?)`)
          .run(row.id, row.discovered);
        // Hidden wins over a simultaneous delete tombstone.
      }
      if (["hidden", "deleted"].includes(row.visibility)) {
        db.prepare(`INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at) VALUES ('local', ?, ?)`)
          .run(row.id, row.discovered);
      }
      if (row.visibility === "closed") {
        db.prepare(`INSERT INTO posting_snapshot_sets
          (tenant_id, job_id, snapshot_set_json, latest_active_state, updated_at)
          VALUES ('local', ?, '{}', 'closed', ?)`).run(row.id, row.discovered);
      }
      if (row.applied) {
        db.prepare(`INSERT INTO job_events (tenant_id, job_id, identity_version, event_type, stage, occurred_at, payload_json)
          VALUES ('local', ?, 1, 'ApplicationManuallyMarked', 'apply', ?, '{}')`).run(row.id, row.scored);
      }
    }
    // Same ID in a different tenant is never eligible.
    db.prepare(`INSERT INTO jobs (tenant_id, job_id, url, title) VALUES ('other', ?, 'https://synthetic.invalid/other', 'Needle')`)
      .run(fixtureRow(0).id);
  })();
  return { db, dbPath, rows };
}

function eligible(row: FixtureRow, query: JobListQuery): boolean {
  const stages = query.stages ?? (query.stage ? [query.stage] : []);
  if (stages.length && !stages.includes(row.stage)) return false;
  if (query.jobStates) {
    if (!query.jobStates.includes(row.visibility as "active" | "hidden" | "deleted")) return false;
  } else if (query.deleted !== "all" && query.deleted !== row.visibility) return false;
  if (query.state && query.state !== row.state) return false;
  if (query.applyStatus === "applied" && !row.applied) return false;
  if (query.source && !row.source.includes(query.source.toLowerCase())) return false;
  if (query.company && !row.company.toLowerCase().includes(query.company.toLowerCase())) return false;
  if (query.normalizedScoreKeyword && query.normalizedScoreKeyword !== row.keyword) return false;
  if (query.minFitScore !== undefined && row.fit < query.minFitScore) return false;
  if (query.maxFitScore !== undefined && row.fit > query.maxFitScore) return false;
  const discovered = !query.discoveredSince || row.discovered >= query.discoveredSince;
  const scored = !query.scoredSince || row.scored >= query.scoredSince;
  if (query.discoveredSince && query.scoredSince ? !discovered && !scored : !discovered || !scored) return false;
  // Every search case uses a literal fixture title.
  if (query.q && !row.title.toLowerCase().includes(query.q.toLowerCase())) return false;
  return true;
}

function ordered(rows: FixtureRow[], field: JobSortField, dir: "asc" | "desc"): FixtureRow[] {
  const value = (row: FixtureRow): string | number => {
    switch (field) {
      case "discovered_at": return row.discovered;
      case "title": return row.title;
      case "company": return row.company;
      case "source": return row.source;
      case "location": return row.location;
      case "fit_score": return row.fit;
      case "current_stage": return row.stage;
      case "current_state": return `${row.state === "failed" ? 0 : 6}:${row.substage}`;
      case "apply_status": return row.applied ? "applied" : "";
      default: return 0; // Equal absent compensation values, equal legacy salary.
    }
  };
  return [...rows].sort((left, right) => {
    const a = value(left), b = value(right);
    const compare = a < b ? -1 : a > b ? 1 : 0;
    return compare * (dir === "asc" ? 1 : -1) || left.id.localeCompare(right.id);
  });
}

describe("combined-stage list pagination", () => {
  it("parses bounded comma/repeated arrays, duplicates, precedence, and empty values", async () => {
    expect(JobListQuerySchema.parse({ stages: ["discover,apply", "discover"] }).stages).toEqual(["discover", "apply"]);
    expect(JobListQuerySchema.parse({ stages: " apply , discover " }).stages).toEqual(["apply", "discover"]);
    for (const stages of [[], ""]) expect(JobListQuerySchema.parse({ stages, stage: "apply" }).stages).toEqual([]);
    for (const stages of [["invalid"], "apply,,discover", Array(7).fill("apply"), 42]) {
      expect(JobStagesFilterSchema.safeParse(stages).success).toBe(false);
      expect(JobListQuerySchema.parse({ stages, stage: "apply" }).stages).toBeUndefined();
      expect(BulkJobMutationFilterSchema.parse({ stages, stage: "apply" }).stages).toBeUndefined();
    }
    expect(JobListQuerySchema.parse({ stage: "apply" }).stage).toBe("apply");
    expect(BulkJobMutationFilterSchema.parse({ stages: ["apply", "apply"] }).stages).toEqual(["apply"]);
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ ok: true, items: [] }), { status: 200 });
    }));
    try {
      const client = new JobCtrlApiClient("http://127.0.0.1:9999");
      await client.jobs({ stages: ["discover", "apply"] });
      await client.jobs({ stages: [], stage: "apply" });
      expect(new URL(urls[0]!).searchParams.get("stages")).toBe("discover,apply");
      expect(new URL(urls[1]!).searchParams.get("stages")).toBe("");
    } finally { vi.unstubAllGlobals(); }
  });

  for (const sort of JOB_SORT_FIELDS) for (const dir of ["asc", "desc"] as const) {
    it(`returns independent totals and pages for ${sort} ${dir} with every list filter`, () => {
      const { db, rows } = seed();
      const filters = [
        {}, { q: "Needle" }, { state: "failed" }, { source: "board-a" }, { company: "acme" },
        { minFitScore: 4 }, { maxFitScore: 7 }, { minFitScore: 4, maxFitScore: 7 },
        { normalizedScoreKeyword: "react" }, { applyStatus: "applied" },
        { discoveredSince: "2026-01-07T00:00:00.000Z" }, { scoredSince: "2026-02-07T00:00:00.000Z" },
        { discoveredSince: "2026-01-07T00:00:00.000Z", scoredSince: "2026-02-07T00:00:00.000Z" },
        ...["all", "hidden", "deleted", "closed"].map((deleted) => ({ deleted })),
        { jobStates: ["active", "deleted", "hidden"], deleted: "closed" },
        { jobStates: ["hidden", "deleted"] }, { stages: ["apply", "apply"], stage: "discover" },
        { stages: [], stage: "apply" }, { stages: ["score", "enrich", "tailor", "cover"] },
        { q: "Needle", source: "board-a", minFitScore: 4, applyStatus: "applied", deleted: "all" },
      ];
      for (const filter of filters) {
        const query = JobListQuerySchema.parse({ stages: ["discover", "apply"], sort, dir, pageSize: 5, ...filter });
        const expected = ordered(rows.filter((row) => eligible(row, query)), sort, dir);
        const pages = Math.max(1, Math.ceil(expected.length / 5));
        for (const requested of [1, 2, 3, pages, 999]) {
          const result = listJobs(db, { ...query, page: requested });
          const page = Math.min(requested, pages);
          expect(result.pagination).toEqual({ page, pageSize: 5, total: expected.length, pages });
          expect(result.items.map((job) => job.jobKey)).toEqual(expected.slice((page - 1) * 5, page * 5).map((row) => row.id));
          expect(result.sort).toEqual({ field: sort, dir });
          expect(result.filter.stages).toEqual([...new Set(query.stages)]);
        }
        // Compare with the old stage-by-stage API, fetching complete lists
        // before globally sorting, never concatenating stage-local pages.
        const scalar = [...new Set(query.stages!.length ? query.stages : ["discover", "apply"] as Stage[])]
          .flatMap((stage) => listJobs(db, { ...query, stages: undefined, stage, pageSize: 200 }).items);
        const scalarIds = new Set(scalar.map((job) => job.jobKey));
        expect(ordered(rows.filter((row) => scalarIds.has(row.id)), sort, dir).map((row) => row.id))
          .toEqual(expected.map((row) => row.id));
        const { page: _page, pageSize: _size, page_size: _sizeAlias, sort: _sort, dir: _dir,
          discovered_since: _discoveredAlias, scored_since: _scoredAlias, ...bulkFilter } = query;
        const bulk = matchingJobKeys(db, BulkJobMutationFilterSchema.parse(bulkFilter));
        expect(bulk.sort()).toEqual(expected.map((row) => row.id).sort());
      }
    }, 30_000);
  }

  it("returns empty page one and keeps scalar metadata compatible", () => {
    const { db } = seed(0);
    const result = listJobs(db, JobListQuerySchema.parse({ stages: ["discover", "apply"], page: 999 }));
    expect(result.items).toEqual([]);
    expect(result.pagination).toEqual({ page: 1, pageSize: 50, total: 0, pages: 1 });
    expect(listJobs(db, JobListQuerySchema.parse({ stage: "apply" })).filter).toMatchObject({ stage: "apply", stages: ["apply"] });
  });

  it("globally orders distinct and missing projected compensation values across stages", () => {
    const { db, rows } = seed();
    listJobs(db, JobListQuerySchema.parse({ deleted: "all" }));
    // Synthetic typed projection inputs test the list reader's contract. Salary
    // extraction and market judgment authority are covered in their own suites.
    const inputs = rows.map((row, index) => ({ row, index,
      minimum: index % 4 === 0 ? null : 60_000 + (index % 7) * 1_000,
      maximum: index % 4 === 0 ? null : 90_000 + (index % 5) * 1_000,
      market: index % 4 === 0 ? null : 100_000 + (index % 6) * 1_000,
      confidence: index % 4 === 0 ? null : (index % 3 + 1) / 4,
      warnings: index % 4,
    }));
    for (const input of inputs) {
      const range = (min: number | null, max: number | null) => min === null ? null : {
        currency: "EUR", period: "year", component: "base_salary", minimumAmount: min, maximumAmount: max,
        annualizedMinimumEur: min, annualizedMaximumEur: max, displayRange: "Synthetic range",
      };
      const summary: JobCompensationSummary = {
        projectionVersion: 4, legacyRawSalary: "EUR 70000", warningCount: input.warnings,
        posted: { sourceKind: "posted", recordStatus: input.minimum === null ? "not_recorded" : "recorded",
          parseState: input.minimum === null ? null : "parsed_range", confidence: "high", warningCount: input.warnings,
          range: range(input.minimum, input.maximum), displayRange: input.minimum === null ? null : "Synthetic range" },
        market: { sourceKind: "reported_company_role_market", benchmarkKind: null,
          recordStatus: input.market === null ? "not_requested" : "recorded",
          estimateState: input.market === null ? "not_requested" : "estimated_range",
          confidenceBand: "medium", confidenceScore: input.confidence, sourceCount: 1, sampleCount: 1, warningCount: 0,
          range: range(input.market, input.market), displayRange: null, confidenceInterval: null, displayConfidenceInterval: null },
      };
      db.prepare("UPDATE job_list_projections SET compensation_summary_json = ? WHERE tenant_id = 'local' AND job_id = ?")
        .run(JSON.stringify(summary), input.row.id);
    }
    for (const sort of JOB_SORT_FIELDS.filter((field) => field.startsWith("compensation_"))) {
      const value = (input: typeof inputs[number]): number => {
        switch (sort) {
          case "compensation_min_eur": return input.minimum ?? Number.NEGATIVE_INFINITY;
          case "compensation_max_eur": return input.maximum ?? Number.NEGATIVE_INFINITY;
          case "compensation_posted": return input.minimum ?? -1;
          case "compensation_market": return input.market ?? Number.NEGATIVE_INFINITY;
          case "compensation_confidence": return input.confidence ?? Number.NEGATIVE_INFINITY;
          case "compensation_warnings": return input.warnings;
          default: throw new Error("unexpected compensation sort");
        }
      };
      for (const dir of ["asc", "desc"] as const) {
        const expected = [...inputs].sort((left, right) => {
          const a = value(left), b = value(right);
          return (a < b ? -1 : a > b ? 1 : 0) * (dir === "asc" ? 1 : -1) || left.row.id.localeCompare(right.row.id);
        }).map((input) => input.row.id);
        for (const page of [1, 2, 5, 999]) {
          const result = listJobs(db, JobListQuerySchema.parse({ stages: ["discover", "apply"], deleted: "all", sort, dir, page, pageSize: 7 }));
          const safePage = Math.min(page, 7);
          expect(result.pagination).toEqual({ page: safePage, pageSize: 7, total: 48, pages: 7 });
          expect(result.items.map((job) => job.jobKey)).toEqual(expected.slice((safePage - 1) * 7, safePage * 7));
        }
      }
    }
  });

  it("counts and reads a clamped SQL page in one snapshot across a concurrent WAL commit", () => {
    const { db, dbPath, rows } = seed();
    const query = JobListQuerySchema.parse({ stages: ["discover", "apply"], deleted: "all", sort: "title", dir: "asc", page: 999, pageSize: 5 });
    const writer = new Database(dbPath);
    cleanups.push(() => writer.close());
    const original = db.prepare.bind(db);
    let injected = false;
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = original(sql);
      if (sql.startsWith("SELECT COUNT(*) AS count FROM job_list_projections")) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementation((...args: unknown[]) => {
          const result = get(...args);
          if (!injected) {
            injected = true;
            writer.prepare("DELETE FROM job_list_projections WHERE tenant_id = 'local' AND job_id = ?").run(rows[47]!.id);
          }
          return result;
        });
      }
      return statement;
    }) as typeof db.prepare);
    const result = listJobs(db, query);
    const expected = ordered(rows, "title", "asc");
    expect(injected).toBe(true);
    expect(result.pagination).toEqual({ page: 10, pageSize: 5, total: 48, pages: 10 });
    expect(result.items.map((job) => job.jobKey)).toEqual(expected.slice(45).map((row) => row.id));
    expect(writer.prepare("SELECT COUNT(*) AS count FROM job_list_projections WHERE tenant_id='local'").get()).toEqual({ count: 47 });
  });
});
