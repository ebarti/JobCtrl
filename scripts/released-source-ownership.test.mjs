import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { establishSourceOwnership } from "./released-source-ownership.mjs";

test("source ownership qualification refuses a non-fixture workspace", { skip: process.platform !== "darwin" }, async () => {
  await assert.rejects(establishSourceOwnership({ sourceBinary: "/bin/false", root: "/", runtime: "/", state: "/", history: "/", python: "/bin/sh", env: {} }), /isolated temporary workspace/);
});

for (const schema of [14, 15]) test(`the source controller establishes and releases legacy ownership at schema ${schema}`, { skip: process.platform !== "darwin" || !process.env.JOBCTRL_RELEASE_QA_TEST_BINARY, timeout: 90_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jobctrl-source-proof-test-")));
  const runtime = path.join(root, "runtime"), state = path.join(root, "state"), home = path.join(root, "home");
  try {
    await mkdir(path.join(state, "temporal"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(runtime, "python"), { recursive: true, mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    const python = path.join(runtime, "python", "python");
    await writeFile(python, '#!/bin/sh\nexec "$TEST_REAL_PYTHON" "$@"\n', { mode: 0o700 });
    const app = path.join(state, "jobctrl.db"), history = path.join(state, "temporal", "temporal.db");
    const realPython = process.env.JOBCTRL_RELEASE_QA_TEST_PYTHON ?? "/usr/bin/python3";
    const seed = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA user_version='+str(int(sys.argv[3]))); c.execute('CREATE TABLE proof (value TEXT)'); c.execute(\"INSERT INTO proof VALUES ('preserved')\"); c.commit(); c.close(); h=sqlite3.connect(sys.argv[2]); h.execute('CREATE TABLE history (value TEXT)'); h.execute(\"INSERT INTO history VALUES ('preserved')\"); h.commit(); h.close()";
    execFileSync(realPython, ["-c", seed, app, history, String(schema)]);
    const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", JOBCTRL_RUNTIME_HOME: runtime, JOBCTRL_DIR: state, TEST_REAL_PYTHON: realPython };
    await establishSourceOwnership({ sourceBinary: process.env.JOBCTRL_RELEASE_QA_TEST_BINARY, root, runtime, state, history, python, env });
    assert.equal(execFileSync(realPython, ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('PRAGMA user_version').fetchone()[0],c.execute('SELECT value FROM proof').fetchone()[0])", app], { encoding: "utf8" }).trim(), `${schema} preserved`);
    assert.equal(execFileSync(realPython, ["-c", "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('SELECT value FROM history').fetchone()[0])", history], { encoding: "utf8" }).trim(), "preserved");
  } finally { await rm(root, { recursive: true, force: true }); }
});
