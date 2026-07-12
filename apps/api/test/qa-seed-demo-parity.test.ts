import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { QA_DEMO_SHARED_LIFECYCLE_STATES } from "@jobctrl/contracts";

import { createQaWorkspace, removeQaWorkspace, type QaWorkspace } from "./qa-seed.js";

describe("QA seed / public demo semantic parity", () => {
  let workspace: QaWorkspace | undefined;

  afterEach(() => {
    if (workspace) {
      removeQaWorkspace(workspace);
      workspace = undefined;
    }
  });

  it("keeps the shared stage lifecycle facts in the real QA workspace", () => {
    workspace = createQaWorkspace();
    const db = new Database(workspace.dbPath, { readonly: true });
    try {
      const states = new Set(
        db
          .prepare("SELECT DISTINCT state FROM job_stage_states")
          .all()
          .map((row) => (row as { state: string }).state),
      );

      expect([...states]).toEqual(expect.arrayContaining([...QA_DEMO_SHARED_LIFECYCLE_STATES]));
    } finally {
      db.close();
    }
  });
});
