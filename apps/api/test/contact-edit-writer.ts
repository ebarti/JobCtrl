/** Independent-process production writer for bounded contact concurrency tests. */
import fs from "node:fs";
import { ContactRevisionConflictError, updateContact } from "../src/contacts.js";
import { openDatabase } from "../src/db.js";
import type { ContactUpdateRequest } from "../src/contracts.js";

const [dbPath, contactId, encoded, releaseFile, waitMode] = process.argv.slice(2);
if (!dbPath || !contactId || !encoded) throw new Error("Missing writer inputs");
const db = openDatabase(dbPath);
// Ordinary competing writers use production admission. Only the deliberately
// blocked barrier contender needs to expire before the parent releases its peer.
if (waitMode === "short-lock-wait") db.pragma("busy_timeout = 100");
if (releaseFile) {
  // Pause after the fingerprint read, before any mutation. This observes the
  // production boundary without adding a synchronization hook to product code.
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.includes("SELECT MAX(event_id)")) {
      const get = statement.get.bind(statement);
      statement.get = (...args: unknown[]) => {
        const result = get(...args);
        process.send?.({ kind: "compared" });
        const deadline = Date.now() + 5_000;
        while (!fs.existsSync(releaseFile)) {
          if (Date.now() > deadline) throw new Error("Contact writer barrier timed out");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        return result;
      };
    }
    return statement;
  }) as typeof db.prepare;
}
process.send?.({ kind: "ready", busyTimeoutMs: db.pragma("busy_timeout", { simple: true }) });
process.once("message", () => {
  try {
    const contact = updateContact(db, contactId, JSON.parse(encoded) as ContactUpdateRequest);
    process.send?.({ kind: "result", outcome: "committed", contact });
  } catch (error) {
    process.send?.({ kind: "result", outcome: error instanceof ContactRevisionConflictError
      ? "conflict" : (error as { code?: string }).code ?? String(error) });
  } finally {
    db.close();
    process.disconnect?.();
  }
});
