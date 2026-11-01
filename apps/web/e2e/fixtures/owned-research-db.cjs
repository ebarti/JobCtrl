const fs = require("node:fs");
const { assertE2eWorkspaceEnvironment } = require("./owned-workspace.cjs");

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function descriptors() {
  const root = fs.existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd";
  const found = new Map();
  for (const name of fs.readdirSync(root)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      found.set(Number(name), fs.fstatSync(Number(name), { bigint: true }));
    } catch {
      // Enumerating the descriptor directory creates a transient descriptor.
    }
  }
  return found;
}

// The caller provides the SQLite opener so tests can reproduce replacement
// precisely at the open boundary. No SQL is executed before fd verification.
function openOwnedResearchDb(dbPath, open, env = process.env, expected = null) {
  const workspace = assertE2eWorkspaceEnvironment(env);
  if (dbPath !== env.JOBCTRL_E2E_DB_PATH) throw new Error("Foreign E2E database");
  if (typeof fs.constants.O_NOFOLLOW !== "number") throw new Error("No-follow ownership checks unavailable");
  const pinned = fs.openSync(dbPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let db;
  try {
    const identity = fs.fstatSync(pinned, { bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n || (expected && !sameIdentity(identity, expected)))
      throw new Error("E2E database identity changed");
    const before = descriptors();
    db = open(dbPath);
    // Do not accept a matching decoy descriptor alongside a different opened
    // file: the SQLite handle must be the only newly retained regular file.
    const candidates = [...descriptors()].filter(([fd, metadata]) => !before.has(fd) && metadata.isFile());
    if (candidates.length !== 1 || !sameIdentity(candidates[0][1], identity))
      throw new Error("Opened SQLite database does not match the owned file");
    const databaseFd = candidates[0][0];

    function verify() {
      const currentWorkspace = assertE2eWorkspaceEnvironment(env);
      if (currentWorkspace.token !== workspace.token) throw new Error("E2E workspace ownership changed");
      const current = fs.lstatSync(dbPath, { bigint: true });
      if (
        !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
        !sameIdentity(current, identity) || !sameIdentity(fs.fstatSync(pinned, { bigint: true }), identity) ||
        !sameIdentity(fs.fstatSync(databaseFd, { bigint: true }), identity)
      ) throw new Error("E2E database identity changed");
    }

    verify();
    return {
      db,
      identity,
      verify,
      close() {
        try { db.close(); } finally { fs.closeSync(pinned); }
      },
    };
  } catch (error) {
    try { db?.close(); } finally { fs.closeSync(pinned); }
    throw error;
  }
}

// Record the committed seed separately from the later task handoff: a worker
// failure between them must still clean the seed, but must not delete a task
// this fixture never inserted.
function createAcquisitionCleanup(open, taskId, jobId) {
  let seedIdentity = null;
  let ownsTask = false;
  return {
    seedCommitted(identity) { seedIdentity = identity; },
    taskCommitted() {
      if (!seedIdentity) throw new Error("Acquisition seed has not committed");
      ownsTask = true;
    },
    cleanup() {
      if (!seedIdentity) return;
      const guard = open(seedIdentity);
      try {
        guard.db.transaction(() => {
          guard.verify();
          if (ownsTask) {
            guard.db.prepare("DELETE FROM contact_candidates WHERE tenant_id = 'local' AND task_id = ?").run(taskId);
            guard.db.prepare("DELETE FROM contact_research_task_projections WHERE tenant_id = 'local' AND task_id = ?").run(taskId);
            guard.db.prepare("DELETE FROM job_events WHERE tenant_id = 'local' AND entity_kind = 'contact_research' AND entity_ref = ?").run(taskId);
            guard.db.prepare("DELETE FROM contact_research_tasks WHERE tenant_id = 'local' AND task_id = ?").run(taskId);
          }
          guard.db.prepare("DELETE FROM application_outcomes WHERE tenant_id = 'local' AND outcome_id = 'outcome-e2e-outreach' AND job_id = ?").run(jobId);
          guard.db.prepare("DELETE FROM job_list_projections WHERE tenant_id = 'local' AND job_id = ?").run(jobId);
          guard.verify();
        })();
      } finally {
        guard.close();
      }
    },
  };
}

module.exports = { createAcquisitionCleanup, openOwnedResearchDb };
