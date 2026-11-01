import { readFile, writeFile } from "node:fs/promises";

// Contracts owns codes and labels; the worker ships an identical resource.
const source = new URL(
  "../packages/contracts/src/semantic-taxonomy.v1.json",
  import.meta.url,
);
const destination = new URL(
  "../workers/automation/src/jobctrl/assets/determinations/taxonomy.v1.json",
  import.meta.url,
);
const bytes = await readFile(source);
const check = process.argv.includes("--check");
async function publish(path, expected) {
  if (check) {
    const actual = await readFile(path);
    if (!actual.equals(Buffer.from(expected))) throw new Error(`Semantic taxonomy drift: ${path.pathname}`);
  } else await writeFile(path, expected);
}
await publish(destination, bytes);
const taxonomy = JSON.parse(bytes);
const typeNames = {
  track: "TrackCode",
  seniority: "SeniorityCode",
  occupationFamily: "OccupationFamilyCode",
  workModel: "WorkModelCode",
  region: "RegionCode",
};
const lines = [
  '"""Generated code types. Edit the Contracts taxonomy and run its sync script."""',
  "",
  "from typing import Literal",
  "",
];
for (const [key, typeName] of Object.entries(typeNames)) {
  const codes = Object.keys(taxonomy[key]).map((code) => JSON.stringify(code));
  const declaration = `${typeName} = Literal[${codes.join(", ")}]`;
  lines.push(declaration.length <= 120 ? declaration : `${typeName} = Literal[\n${codes.map(code => `    ${code},`).join("\n")}\n]`);
}
await publish(
  new URL(
    "../workers/automation/src/jobctrl/domain/taxonomy_codes.py",
    import.meta.url,
  ),
  lines.join("\n") + "\n",
);

const sqlPath = new URL(
  "../workers/automation/src/jobctrl/infrastructure/migrations/schema_v13.sql",
  import.meta.url,
);
const sql = await readFile(sqlPath, "utf8");
const sqlQuote = (value) => "'" + value.replaceAll("'", "''") + "'";
const seed = [
  "-- BEGIN GENERATED OCCUPATION CODES",
  "DROP TRIGGER prevent_compensation_role_family_delete;",
  "DELETE FROM compensation_role_families;",
  "INSERT INTO compensation_role_families (taxonomy_version,role_family_code,display_name,isco_codes_json,created_at) VALUES",
  Object.entries(taxonomy.occupationFamily)
    .map(
      ([code, label]) =>
        `(${sqlQuote(taxonomy.schemaVersion)},${sqlQuote(code)},${sqlQuote(label)},'[]','2026-10-06T00:00:00Z')`,
    )
    .join(",\n") + ";",
  "CREATE TRIGGER prevent_compensation_role_family_delete\nBEFORE DELETE ON compensation_role_families\nBEGIN\n    SELECT RAISE(ABORT, 'compensation role families are append-only');\nEND;",
  "-- END GENERATED OCCUPATION CODES",
].join("\n");
const updated = sql.includes("-- BEGIN GENERATED OCCUPATION CODES")
  ? sql.replace(
      /-- BEGIN GENERATED OCCUPATION CODES[\s\S]*?-- END GENERATED OCCUPATION CODES/,
      seed,
    )
  : sql.replace(
      "CREATE TABLE compensation_market_refresh_state (",
      seed + "\nCREATE TABLE compensation_market_refresh_state (",
    );
await publish(sqlPath, updated);
if (check) console.log("Semantic taxonomy resources, code types and SQL seeds match Contracts.");
