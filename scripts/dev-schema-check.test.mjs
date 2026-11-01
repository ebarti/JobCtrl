import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const checker = path.join(root, "scripts/dev-schema-check.py");
const migrationDir = path.join(root, "workers/automation/src/jobctrl/infrastructure/migrations");

test("source preflight recognizes exact, incompatible and unreadable synthetic schemas without writing", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "jobctrl-schema-preflight-"));
  try {
    const probe = (db) => {
      const result = spawnSync("python3", [checker, db], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    assert.equal(probe(path.join(directory, "missing.db")), "compatible");
    const make = (name, version) => {
      const db = path.join(directory, name);
      const result = spawnSync("python3", ["-c", `import sqlite3,sys
from pathlib import Path
c=sqlite3.connect(sys.argv[1])
if sys.argv[2] == 'exact':
    for version in range(7, 16):
        c.executescript((Path(sys.argv[3]) / ('schema_v%s.sql' % version)).read_text())
    c.execute('PRAGMA user_version=15')
else:
    c.execute('CREATE TABLE sentinel (v TEXT)')
    c.execute('INSERT INTO sentinel VALUES (?)', ('synthetic',))
    c.execute('PRAGMA user_version=' + sys.argv[2])
c.commit()
c.close()`, db, String(version), migrationDir], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return db;
    };
    for (const [name, version, expected] of [
      ["old.db", 14, "incompatible"],
      ["newer.db", 16, "incompatible"],
      ["malformed.db", 15, "incompatible"],
      ["exact.db", "exact", "compatible"],
    ]) {
      const db = make(name, version);
      const before = readFileSync(db);
      assert.equal(probe(db), expected);
      assert.deepEqual(readFileSync(db), before);
    }
    const bad = path.join(directory, "not-sqlite.db");
    writeFileSync(bad, "synthetic non-database");
    assert.equal(probe(bad), "unknown");
    assert.equal(readFileSync(bad, "utf8"), "synthetic non-database");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
