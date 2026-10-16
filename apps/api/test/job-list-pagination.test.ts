import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobCtrlApiClient } from "@jobctrl/api-client";
import { filterJob } from "@jobctrl/contracts";
import {
  BulkJobMutationFilterSchema, JOB_SORT_FIELDS, JobListQuerySchema, JobStagesFilterSchema, STAGES,
  type JobCompensationSummary, type JobListQuery, type JobSortField, type JobSummary, type PaginatedResponse, type Stage,
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
    discovered: new Date(Date.UTC(2026, 0, Math.floor(index / 4) + 1)).toISOString(),
    scored: new Date(Date.UTC(2026, 1, 12 - Math.floor(index / 4))).toISOString(),
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
  it.each(["asc", "desc"] as const)(
    "keeps mixed-notation discovery %s pages identical with search and the browser merger",
    async (dir) => {
      const { db, rows } = seed(8);
      const timestamps = [
        "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00.600Z",
        "2026-01-01T00:00:00.600000+00:00", "2026-01-02T00:00:00+00:00",
        "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00.600000+00:00",
        null, "invalid",
      ];
      for (const [index, row] of rows.entries()) {
        db.prepare("UPDATE jobs SET title = 'Needle', discovered_at = ? WHERE tenant_id = 'local' AND job_id = ?")
          .run(timestamps[index], row.id);
      }
      const adapterUrl = new URL("../../web/src/contexts/operations/jobsListQuery.ts", import.meta.url).href;
      const { fetchJobsList } = await import(adapterUrl) as {
        fetchJobsList(api: Pick<JobCtrlApiClient, "jobs">, input: Partial<JobListQuery>): Promise<PaginatedResponse<JobSummary>>;
      };
      const api = { jobs: async (input: Partial<JobListQuery>) => listJobs(db, JobListQuerySchema.parse(input)) };
      // Preserve the browser's raw-string locale order, not instant order or
      // SQLite binary order. Missing values sort first; ties keep ascending IDs.
      const order = dir === "asc" ? [6, 2, 5, 1, 0, 4, 3, 7] : [7, 3, 0, 4, 1, 2, 5, 6];
      const selections: Partial<JobListQuery>[] = [
        { stages: ["discover", "apply", "discover"] }, { stage: "discover" },
        { stage: "apply" }, { stages: [] }, {},
      ];
      for (const selection of selections) {
        const stages = selection.stages ?? (selection.stage ? [selection.stage] : []);
        const selected = order.filter((index) => !stages.length || stages.includes(rows[index]!.stage));
        for (const q of ["", "Needle"]) {
          for (const pageSize of [1, 3]) {
            const pages = Math.ceil(selected.length / pageSize);
            for (const page of [...Array.from({ length: pages }, (_, index) => index + 1), 999]) {
              const query = JobListQuerySchema.parse({ ...selection, deleted: "all", sort: "discovered_at", dir, q, page, pageSize });
              const safePage = Math.min(page, pages);
              const expected = selected.slice((safePage - 1) * pageSize, safePage * pageSize).map((index) => rows[index]!.id);
              for (const result of [listJobs(db, query), await fetchJobsList(api, query)]) {
                expect(result.pagination).toEqual({ page: safePage, pageSize, total: selected.length, pages });
                expect(result.items.map((job) => job.jobKey), JSON.stringify(query)).toEqual(expected);
              }
            }
          }
        }
      }
    },
  );

  it.each(["discoveredSince", "scoredSince"] as const)(
    "compares %s instants before totals, adjacent/clamped pages and bulk selection",
    (field) => {
      const { db, rows } = seed(13);
      const timestamps = [
        "2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.499999Z",
        "2026-01-01T00:00:00.500000+00:00", "2026-01-01T00:00:00.600000+00:00",
        "2026-01-01T00:00:00.600Z", "2026-01-01T01:00:00.600+01:00",
        "2025-12-31T23:00:00.600-01:00", "2026-01-01T00:00:00.599999Z",
        "2026-01-01T00:00:00.600999Z", "2026-01-01T00:00:00.601Z", null, "invalid",
      ];
      for (const [index, row] of rows.entries()) {
        db.prepare("UPDATE jobs SET title = 'Needle', discovered_at = ? WHERE tenant_id = 'local' AND job_id = ?")
          .run(timestamps[index], row.id);
        db.prepare("UPDATE job_scores SET fit_score = 7, scored_at = ? WHERE tenant_id = 'local' AND job_id = ?")
          .run(timestamps[index] ?? "", row.id);
      }
      // Explicit expected membership at millisecond precision, independent of
      // production timestamp parsing. Extra fractional digits truncate, not round.
      const cases: Array<[string, number[]]> = [
        ["2026-01-01T00:00:00.500Z", [3, 4, 5, 6, 7, 8, 9, 10]],
        ["2026-01-01T00:00:00.600Z", [4, 5, 6, 7, 9, 10]],
        ["2026-01-01T00:00:00.601Z", [10]],
        ["2026-01-01T00:00:00.602Z", []],
      ];
      for (const [since, selected] of cases) {
        for (const stages of [{ stages: ["discover", "apply", "discover"] }, { stage: "apply" }]) {
          const expected = selected.filter((index) => !stages.stage || rows[index]!.stage === stages.stage)
            .map((index) => rows[index]!.id);
          for (const q of ["", "Needle"]) {
            const input = { ...stages, deleted: "all", [field]: since, q };
            expect(matchingJobKeys(db, BulkJobMutationFilterSchema.parse(input)).sort()).toEqual(expected);
            // fit_score exercises the formerly SQL-paged route; title exercises
            // the materialized route. Equal values keep ascending-ID ties.
            for (const sort of ["fit_score", "title"] as const) {
              for (const dir of ["asc", "desc"] as const) {
                for (const page of [...expected.map((_, index) => index + 1), 999]) {
                  const query = JobListQuerySchema.parse({ ...input, sort, dir, page, pageSize: 1 });
                  const result = listJobs(db, query);
                  const pages = Math.max(1, expected.length), safePage = Math.min(page, pages);
                  expect(result.pagination, JSON.stringify(query)).toEqual({ page: safePage, pageSize: 1, total: expected.length, pages });
                  expect(result.items.map((job) => job.jobKey)).toEqual(expected.slice(safePage - 1, safePage));
                  expect(result.filter[field]).toBe(since);
                }
              }
            }
          }
        }
      }
    },
  );

  it("preserves timestamp OR membership when either timestamp is absent or older", () => {
    const { db, rows } = seed(6);
    const older = "2026-01-01T00:00:00Z", equal = "2026-01-01T00:00:00.600000+00:00";
    const discovered = [equal, older, equal, null, "invalid", older];
    const scored = [older, equal, null, equal, "invalid", older];
    for (const [index, row] of rows.entries()) {
      db.prepare("UPDATE jobs SET title = 'Needle', discovered_at = ? WHERE tenant_id = 'local' AND job_id = ?")
        .run(discovered[index], row.id);
      db.prepare("UPDATE job_scores SET fit_score = 7, scored_at = ? WHERE tenant_id = 'local' AND job_id = ?")
        .run(scored[index] ?? "", row.id);
    }
    for (const q of ["", "Needle"]) {
      const input = { stages: ["discover", "apply"], deleted: "all", q,
        discoveredSince: "2026-01-01T00:00:00.600Z", scoredSince: "2026-01-01T00:00:00.600Z" };
      const expected = rows.slice(0, 4).map((row) => row.id);
      expect(matchingJobKeys(db, BulkJobMutationFilterSchema.parse(input)).sort()).toEqual(expected);
      const result = listJobs(db, JobListQuerySchema.parse({ ...input, sort: "fit_score", pageSize: 2, page: 999 }));
      expect(result.pagination).toEqual({ page: 2, pageSize: 2, total: 4, pages: 2 });
      expect(result.items.map((job) => job.jobKey)).toEqual(expected.slice(2));
    }
  });

  it.each(["title", "company", "location"] as const)(
    "keeps mixed-case and Unicode %s pages identical with search and the browser merger",
    async (sort) => {
      const { db, rows } = seed(6);
      const labels = ["Needle A", "Needle a", "Needle Z", "Needle é", "Needle E", "Needle É"];
      for (const [index, row] of rows.entries()) {
        db.prepare("UPDATE jobs SET title = ?, company = ?, location = ? WHERE tenant_id = 'local' AND job_id = ?")
          .run(labels[index], labels[index], labels[index], row.id);
      }
      const adapterUrl = new URL("../../web/src/contexts/operations/jobsListQuery.ts", import.meta.url).href;
      const { fetchJobsList } = await import(adapterUrl) as {
        fetchJobsList(api: Pick<JobCtrlApiClient, "jobs">, input: Partial<JobListQuery>): Promise<PaginatedResponse<JobSummary>>;
      };
      const api = { jobs: async (input: Partial<JobListQuery>) => listJobs(db, JobListQuerySchema.parse(input)) };
      // Lowercase ties retain ascending IDs even in descending order. Accented
      // e sorts beside e, before z; these orders are independent seed facts.
      for (const dir of ["asc", "desc"] as const) {
        const order = dir === "asc" ? [0, 1, 4, 3, 5, 2] : [2, 3, 5, 4, 0, 1];
        for (const q of ["", "Needle"]) {
          for (const pageSize of [1, 2, 3]) {
            const pages = 6 / pageSize;
            for (const page of [...Array.from({ length: pages }, (_, index) => index + 1), 999]) {
              const query = JobListQuerySchema.parse({ stages: ["discover", "apply"], deleted: "all", sort, dir, q, page, pageSize });
              const safePage = Math.min(page, pages);
              const expected = order.slice((safePage - 1) * pageSize, safePage * pageSize).map((index) => rows[index]!.id);
              for (const result of [listJobs(db, query), await fetchJobsList(api, query)]) {
                expect(result.pagination).toEqual({ page: safePage, pageSize, total: 6, pages });
                expect(result.items.map((job) => job.jobKey), JSON.stringify(query)).toEqual(expected);
              }
            }
          }
        }
      }
    },
  );

  it("orders mixed failed/exhausted states by their presented state before pagination", () => {
    const { db, rows } = seed(6);
    const states = ["exhausted", "failed", "failed", "pending", "exhausted", "pending"];
    for (const [index, row] of rows.entries()) {
      db.prepare("UPDATE jobs SET title = 'Needle' WHERE tenant_id = 'local' AND job_id = ?").run(row.id);
      for (const stage of STAGES) {
        const state = stage === row.stage ? states[index]
          : STAGES.indexOf(stage) < STAGES.indexOf(row.stage) ? "succeeded" : "pending";
        db.prepare("UPDATE job_stage_states SET state = ? WHERE tenant_id = 'local' AND job_id = ? AND stage = ?")
          .run(state, row.id, stage);
      }
    }
    for (const state of [undefined, "failed", "exhausted"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const order = state === "exhausted" ? [0, 4] : state === "failed"
          ? dir === "asc" ? [1, 0, 2, 4] : [0, 2, 4, 1]
          : dir === "asc" ? [1, 0, 2, 4, 3, 5] : [3, 5, 0, 2, 4, 1];
        for (const q of ["", "Needle"]) {
          for (const page of [...order.map((_, index) => index + 1), 999]) {
            const query = JobListQuerySchema.parse({ stages: ["discover", "apply"], deleted: "all", state,
              sort: "current_state", dir, q, page, pageSize: 1 });
            const result = listJobs(db, query);
            const safePage = Math.min(page, order.length);
            expect(result.pagination).toEqual({ page: safePage, pageSize: 1, total: order.length, pages: order.length });
            expect(result.items.map((job) => job.jobKey), JSON.stringify(query)).toEqual([rows[order[safePage - 1]!]!.id]);
          }
        }
      }
    }
  });

  it.each(["source", "company"] as const)("uses literal Unicode-aware %s filters for pages and all-matching selection", (field) => {
    const { db, rows } = seed(6);
    const values = ["Board-a", "Board%a", "Board_a", "Board\\a", "Équipe", "éQUIPE"];
    for (const [index, row] of rows.entries()) {
      db.prepare("UPDATE jobs SET title = 'Needle', company = ?, site = ? WHERE tenant_id = 'local' AND job_id = ?")
        .run(values[index], values[index], row.id);
    }
    const cases: Array<[string, number[]]> = [["Board%", [1]], ["Board_", [2]], ["Board\\", [3]],
      ["board", [0, 1, 2, 3]], ["équipe", [4, 5]], ["Absent%", []]];
    for (const [value, order] of cases) {
      for (const q of ["", "Needle"]) {
        const input = { stages: ["discover", "apply"], deleted: "all", [field]: value, q };
        const filter = BulkJobMutationFilterSchema.parse(input);
        expect(matchingJobKeys(db, filter).sort(), JSON.stringify(filter)).toEqual(order.map((index) => rows[index]!.id).sort());
        for (const sort of ["title", "discovered_at"] as const) {
          // Equal discovered timestamps and titles leave the ascending ID tie.
          const expected = order;
          for (const page of [1, 2, 999]) {
            const query = JobListQuerySchema.parse({ ...input, sort, dir: "asc", page, pageSize: 1 });
            const result = listJobs(db, query);
            const pages = Math.max(1, expected.length), safePage = Math.min(page, pages);
            expect(result.pagination).toEqual({ page: safePage, pageSize: 1, total: expected.length, pages });
            expect(result.items.map((job) => job.jobKey), JSON.stringify(query))
              .toEqual(expected.slice(safePage - 1, safePage).map((index) => rows[index]!.id));
          }
        }
      }
    }
  });

  it.each(["exhausted", "failed", "pending"] as const)(
    "keeps %s membership consistent across scalar/combined lists, search, every sort, and bulk selection",
    (state) => {
      const { db } = seed(0);
      const inputs = (["exhausted", "failed", "pending"] as const).flatMap((storedState, stateIndex) =>
        (["discover", "apply"] as const).map((stage, stageIndex) => ({
          id: fixtureRow(stateIndex * 2 + stageIndex).id, stage, storedState,
        })),
      );
      db.transaction(() => {
        for (const input of inputs) {
          db.prepare(`INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at)
            VALUES ('local', ?, ?, 'Needle', 'Synthetic', 'board-a', '2026-01-01')`)
            .run(input.id, `https://synthetic.invalid/${input.id}`);
          for (const stage of STAGES) {
            const value = stage === input.stage ? input.storedState
              : STAGES.indexOf(stage) < STAGES.indexOf(input.stage) ? "succeeded" : "pending";
            db.prepare(`INSERT INTO job_stage_states (tenant_id, job_id, stage, state, updated_at, version)
              VALUES ('local', ?, ?, ?, '2026-01-01', 1)`).run(input.id, stage, value);
          }
        }
      })();
      const summaries = listJobs(db, JobListQuerySchema.parse({ pageSize: 200 })).items;
      const rawSummaries = summaries.map((job) => ({
        ...job, currentState: inputs.find((input) => input.id === job.jobKey)!.storedState, failureReason: null,
      }));
      for (const selection of [{ stages: ["discover", "apply", "discover"] }, { stage: "discover" }, { stage: "apply" }]) {
        const stages = selection.stages ?? [selection.stage];
        const eligibleIds = inputs.filter((input) => stages.includes(input.stage)
          && (input.storedState === state || state === "failed" && input.storedState === "exhausted"))
          .map((input) => input.id).sort();
        for (const q of ["", "Needle", "Absent"]) {
          const expectedIds = q === "Absent" ? [] : eligibleIds;
          const filter = BulkJobMutationFilterSchema.parse({ ...selection, state, q });
          expect(matchingJobKeys(db, filter).sort(), JSON.stringify(filter)).toEqual(expectedIds);
          // The shared demo filter can receive the raw legacy state; the API
          // supplies the public failed state with an exhaustion failure reason.
          const sharedQuery = JobListQuerySchema.parse(filter);
          for (const jobs of [summaries, rawSummaries]) {
            expect(jobs.filter((job) => filterJob(job, sharedQuery, q.toLowerCase()))
              .map((job) => job.jobKey).sort()).toEqual(expectedIds);
          }
          for (const sort of JOB_SORT_FIELDS) {
            for (const dir of ["asc", "desc"] as const) {
              const query = JobListQuerySchema.parse({ ...selection, state, q, sort, dir, pageSize: 1 });
              const complete = listJobs(db, { ...query, pageSize: 200 });
              expect(complete.pagination.total, JSON.stringify(query)).toBe(expectedIds.length);
              expect(complete.items.map((job) => job.jobKey).sort()).toEqual(expectedIds);
              for (const job of complete.items) {
                const input = inputs.find((input) => input.id === job.jobKey)!;
                expect(job.currentState).toBe(input.storedState === "pending" ? "pending" : "failed");
                expect(job.failureReason).toBe(input.storedState === "exhausted" ? "attempt_budget_exhausted" : null);
              }
              const traversal: string[] = [];
              for (let page = 1; page <= Math.max(1, expectedIds.length); page += 1) {
                const result = listJobs(db, { ...query, page });
                expect(result.pagination).toEqual({ page, pageSize: 1, total: expectedIds.length, pages: Math.max(1, expectedIds.length) });
                traversal.push(...result.items.map((job) => job.jobKey));
              }
              expect(traversal).toEqual(complete.items.map((job) => job.jobKey));
              const last = listJobs(db, { ...query, page: 999 });
              expect(last.pagination.page).toBe(Math.max(1, expectedIds.length));
              expect(last.items.map((job) => job.jobKey)).toEqual(traversal.slice(-1));
            }
          }
        }
      }
    }, 30_000,
  );

  it("keeps the existing browser adapter compatible across multiple stage-local pages", async () => {
    // Load this runtime fixture through its URL so the API compiler keeps its
    // rootDir boundary; the adapter's public input/output use shared contracts.
    const adapterUrl = new URL("../../web/src/contexts/operations/jobsListQuery.ts", import.meta.url).href;
    const { fetchJobsList } = await import(adapterUrl) as {
      fetchJobsList(api: Pick<JobCtrlApiClient, "jobs">, input: Partial<JobListQuery>): Promise<PaginatedResponse<JobSummary>>;
    };
    const { db, rows } = seed(640);
    const api = {
      jobs: vi.fn(async (input: Partial<JobListQuery>) => listJobs(db, JobListQuerySchema.parse(input))),
    };
    for (const sort of ["discovered_at", "title", "company", "fit_score"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        for (const requestedPage of [1, 2, 20, 999]) {
          const input = { stages: ["discover", "apply", "discover"] as Stage[], sort, dir, page: requestedPage, pageSize: 25 };
          const query = JobListQuerySchema.parse(input);
          const expected = ordered(rows.filter((row) => eligible(row, query)), sort, dir);
          const pages = Math.max(1, Math.ceil(expected.length / query.pageSize));
          const safePage = Math.min(requestedPage, pages);
          const ids = expected.slice((safePage - 1) * query.pageSize, safePage * query.pageSize).map((row) => row.id);
          const combined = listJobs(db, query);
          const browser = await fetchJobsList(api, input);
          for (const result of [combined, browser]) {
            expect(result.pagination).toEqual({ page: safePage, pageSize: query.pageSize, total: expected.length, pages });
            expect(result.items.map((job) => job.jobKey)).toEqual(ids);
          }
        }
      }
    }
    // Both public stages exceed the adapter's 200-row fetch limit. A deep
    // page must actually exercise its later stage-local fetches.
    for (const stage of ["discover", "apply"] as const) {
      expect(api.jobs.mock.calls.some(([input]) => input.stage === stage && input.page === 2)).toBe(true);
    }
  }, 30_000);

  it.each([undefined, "apply"] as const)("treats explicit undefined stages as omission with scalar %s", (stage) => {
    const { db, rows } = seed();
    const expectedIds = rows.filter((row) => row.visibility === "active" && (!stage || row.stage === stage))
      .map((row) => row.id).sort();
    for (const sort of ["discovered_at", "source"] as const) {
      const input = { stage, sort, page: 999, pageSize: 5 };
      const omitted = JobListQuerySchema.parse(input);
      const explicit = JobListQuerySchema.parse({ ...input, stages: undefined });
      expect(explicit.stages).toBeUndefined();
      expect(explicit.stage).toBe(stage);
      const result = listJobs(db, explicit);
      expect(result).toEqual(listJobs(db, omitted));
      expect(result.pagination.total).toBe(expectedIds.length);
      expect(result.filter.stages).toEqual(stage ? [stage] : []);
    }
    const omitted = BulkJobMutationFilterSchema.parse({ stage });
    const explicit = BulkJobMutationFilterSchema.parse({ stage, stages: undefined });
    expect(explicit.stages).toBeUndefined();
    expect(explicit.stage).toBe(stage);
    expect(matchingJobKeys(db, explicit).sort()).toEqual(expectedIds);
    expect(matchingJobKeys(db, explicit)).toEqual(matchingJobKeys(db, omitted));
  });

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
        ...["discover", "apply"].flatMap((stage) => ["", "Needle"].map((q) => ({ stages: [stage], q }))),
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

  it.each(["fit_score", "discovered_at", "title"] as const)("releases a failed %s read transaction and recovers the same page", (sort) => {
    const { db } = seed();
    const query = JobListQuerySchema.parse({ stages: ["discover", "apply"], sort, page: 999, pageSize: 5 });
    const accepted = listJobs(db, query);
    const original = db.prepare.bind(db);
    let inject = true;
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (inject && sql.startsWith("SELECT ") && sql.includes(" FROM job_list_projections WHERE")) {
        expect(db.inTransaction).toBe(true);
        inject = false;
        throw new Error("synthetic list read failure");
      }
      return original(sql);
    }) as typeof db.prepare);
    expect(() => listJobs(db, query)).toThrow("synthetic list read failure");
    expect(inject).toBe(false);
    expect(db.inTransaction).toBe(false);
    expect(listJobs(db, query)).toEqual(accepted);
  });

  it.each(["fit_score", "discovered_at", "title"] as const)("reads a clamped %s page in one snapshot across a concurrent WAL commit", (sort) => {
    const { db, dbPath, rows } = seed();
    const query = JobListQuerySchema.parse({ stages: ["discover", "apply"], deleted: "all", sort, dir: "asc", page: 999, pageSize: 5 });
    const writer = new Database(dbPath);
    cleanups.push(() => writer.close());
    const original = db.prepare.bind(db);
    let injected = false;
    const commit = () => {
      if (injected) return;
      injected = true;
      expect(db.inTransaction).toBe(true);
      writer.prepare("DELETE FROM job_list_projections WHERE tenant_id = 'local' AND job_id = ?").run(rows[47]!.id);
    };
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = original(sql);
      if (sql.startsWith("SELECT COUNT(*) AS count FROM ") && sql.includes("temp.job_query_rows qi")) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementation((...args: unknown[]) => {
          const result = get(...args);
          commit();
          return result;
        });
      }
      return statement;
    }) as typeof db.prepare);
    const result = listJobs(db, query);
    const expected = ordered(rows, sort, "asc");
    expect(injected).toBe(true);
    expect(result.pagination).toEqual({ page: 10, pageSize: 5, total: 48, pages: 10 });
    expect(result.items.map((job) => job.jobKey)).toEqual(expected.slice(45).map((row) => row.id));
    expect(writer.prepare("SELECT COUNT(*) AS count FROM job_list_projections WHERE tenant_id='local'").get()).toEqual({ count: 47 });
  });
});
