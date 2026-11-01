import Database from "better-sqlite3";
import { acknowledgeDigest } from "../src/read-model.js";

const [dbPath, timestamp, now] = process.argv.slice(2);
if (!dbPath || !timestamp || !now) throw new Error("missing synthetic acknowledgement arguments");
const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");
try {
  process.stdout.write("READY\n");
  const result = acknowledgeDigest(db, { acknowledgedAt: timestamp, now: new Date(now) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  db.close();
}
