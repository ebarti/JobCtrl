import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { openDatabase, openReadOnlyDatabase } from "../src/db.js";
import { initializeExactDatabase } from "./exact-schema.js";

describe("database initialization admission", () => {
  it.each([openDatabase, openReadOnlyDatabase])("refuses a retained publication before opening SQLite", (open) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-init-admission-"));
    try {
      const dbPath = path.join(root, "jobctrl.db");
      initializeExactDatabase(dbPath);
      const staging = path.join(root, ".jobctrl-init-synthetic");
      fs.mkdirSync(staging);
      fs.linkSync(dbPath, path.join(staging, "candidate.db"));
      const journal = `${dbPath}-journal`;
      fs.writeFileSync(journal, "unrelated companion");
      expect(() => open(dbPath)).toThrow(/unresolved publication/);
      expect(fs.readFileSync(journal, "utf8")).toBe("unrelated companion");
      expect(fs.existsSync(dbPath)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not mistake an unrelated staging file for the database", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-init-unrelated-"));
    try {
      const dbPath = path.join(root, "jobctrl.db");
      initializeExactDatabase(dbPath);
      const staging = path.join(root, ".jobctrl-init-unrelated");
      fs.mkdirSync(staging);
      fs.writeFileSync(path.join(staging, "candidate.db"), "unrelated");
      const db = openDatabase(dbPath);
      db.close();
      expect(fs.readFileSync(path.join(staging, "candidate.db"), "utf8")).toBe("unrelated");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for an active initialization publication to settle", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-init-settle-"));
    try {
      const dbPath = path.join(root, "jobctrl.db");
      initializeExactDatabase(dbPath);
      const staging = path.join(root, ".jobctrl-init-active");
      fs.mkdirSync(staging);
      fs.linkSync(dbPath, path.join(staging, "candidate.db"));
      const child = spawn(process.execPath, ["-e", "setTimeout(() => { require('fs').unlinkSync(process.argv[1]); }, 100)", path.join(staging, "candidate.db")], { stdio: "ignore" });
      const exited = once(child, "exit");
      const db = openDatabase(dbPath);
      db.close();
      const [code] = await exited;
      expect(code).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
