import fs from "node:fs";

// An owned fake helper: the first byte was consumed by the shell gate.
const input = fs.readFileSync(0, "utf8");
fs.writeFileSync(process.env.SYNTHETIC_READY, "ready");
const deadline = Date.now() + 5_000;
while (!fs.existsSync(process.env.SYNTHETIC_RELEASE) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (!fs.existsSync(process.env.SYNTHETIC_RELEASE)) process.exit(1);
const state = JSON.parse(fs.readFileSync(process.env.SYNTHETIC_STATE, "utf8"));
state.ANTHROPIC_API_KEY = input.split("\n")[0];
fs.writeFileSync(process.env.SYNTHETIC_STATE, JSON.stringify(state));
fs.writeFileSync(process.env.SYNTHETIC_DONE, "done");
