import Database from "better-sqlite3";
import { decideOutcomeSuggestion } from "../../src/application-feedback.ts";

const db = new Database(process.argv[2]);
db.pragma("busy_timeout = 10000");
process.send?.({ phase: "ready" });
process.on("message", (message) => {
  if (message !== "go") return;
  process.send?.({ phase: "attempting" });
  try {
    const result = decideOutcomeSuggestion(db, process.argv[3], JSON.parse(process.argv[4]));
    process.send?.({ phase: "result", result });
  } catch (error) {
    process.send?.({ phase: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    db.close();
    process.disconnect?.();
  }
});
