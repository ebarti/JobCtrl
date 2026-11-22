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
  seniority: "SeniorityCode",
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
    "../workers/automation/src/jobctrl/semantic/taxonomy_codes.py",
    import.meta.url,
  ),
  lines.join("\n") + "\n",
);

if (check) console.log("Semantic taxonomy resources and Python code types match Contracts.");
