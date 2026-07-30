import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  EventIdentityUpcastError,
  upcastEventIdentity,
} from "../src/event-identity-upcast.js";

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "../../../packages/domain-types/test/fixtures/event_identity_upcast_v1.json",
    import.meta.url,
  ),
);

interface FixtureJob {
  tenantId: string;
  jobId: string;
  postingUrl: string;
  aliases?: string[];
}

interface FixtureCase {
  name: string;
  tenantId: string;
  eventJobReference: string | null;
  payload: unknown;
  expected?: {
    jobId: string | null;
    referencedJobIds: string[];
    payload: Record<string, unknown>;
  };
  expectedError?: string;
}

interface Fixture {
  version: number;
  jobs: FixtureJob[];
  cases: FixtureCase[];
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
const databases: Database.Database[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function seededDb(): Database.Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE jobs (
      tenant_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      url TEXT NOT NULL,
      PRIMARY KEY (tenant_id, job_id),
      UNIQUE (tenant_id, url)
    );
    CREATE TABLE job_identity_aliases (
      tenant_id TEXT NOT NULL,
      alias_kind TEXT NOT NULL,
      alias_value TEXT NOT NULL,
      job_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, alias_kind, alias_value)
    );
  `);
  const insertJob = db.prepare(
    "INSERT INTO jobs (tenant_id, job_id, url) VALUES (?, ?, ?)",
  );
  const insertAlias = db.prepare(
    `INSERT INTO job_identity_aliases (
       tenant_id, alias_kind, alias_value, job_id
     ) VALUES (?, 'posting_url', ?, ?)`,
  );
  for (const job of fixture.jobs) {
    insertJob.run(job.tenantId, job.jobId, job.postingUrl);
    for (const alias of job.aliases ?? []) {
      insertAlias.run(job.tenantId, alias, job.jobId);
    }
  }
  return db;
}

describe("historical event identity upcast", () => {
  it.each(fixture.cases)("$name", (testCase) => {
    const db = seededDb();
    try {
      const result = upcastEventIdentity(db, {
        tenantId: testCase.tenantId,
        eventJobReference: testCase.eventJobReference,
        payload: testCase.payload,
      });
      expect(testCase.expectedError).toBeUndefined();
      expect(result).toEqual({
        version: fixture.version,
        ...testCase.expected,
      });
    } catch (error) {
      expect(testCase.expectedError).toBeDefined();
      expect(error).toBeInstanceOf(EventIdentityUpcastError);
      expect((error as EventIdentityUpcastError).code).toBe(testCase.expectedError);
      expect(String(error)).not.toContain(
        testCase.eventJobReference ?? "https://missing.example/job",
      );
    }
  });

  it("resolves current URLs and stable IDs without an alias table", () => {
    const db = seededDb();
    db.exec("DROP TABLE job_identity_aliases");

    const byUrl = upcastEventIdentity(db, {
      tenantId: "local",
      eventJobReference: "https://jobs.example/a",
      payload: {},
    });
    const byId = upcastEventIdentity(db, {
      tenantId: "local",
      eventJobReference: "22222222-2222-4222-8222-222222222222",
      payload: {},
    });

    expect(byUrl.jobId).toBe("11111111-1111-4111-8111-111111111111");
    expect(byId.jobId).toBe("22222222-2222-4222-8222-222222222222");
  });
});
