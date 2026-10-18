/** Mixed-runtime fixture entry point; only opens the supplied temporary DB. */
import { openDatabase } from "../../src/db.js";
import { refreshProjections, repairJobDetailProjections } from "../../src/projections.js";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("A fixture database path is required");
const db = openDatabase(dbPath);
try {
  if (process.argv[3] === "--repair-detail") repairJobDetailProjections(db);
  refreshProjections(db);
} finally {
  db.close();
}
