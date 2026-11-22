import { readFile } from "node:fs/promises";
import { verifyInstalledJourneyClosure } from "./installed-journey-evidence.mjs";

const [buildResult, shardReports] = process.argv.slice(2);
if (process.argv.length !== 4) throw new Error("Pass the build-result.json file and the shard report directory");

const build = JSON.parse(await readFile(buildResult, "utf8"));
const proof = await verifyInstalledJourneyClosure(build, shardReports);
process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
