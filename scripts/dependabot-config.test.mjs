import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const configPath = fileURLToPath(new URL("../.github/dependabot.yml", import.meta.url));
const rubyYamlToJson = String.raw`
document = YAML.safe_load(
  File.read(ARGV.fetch(0)),
  permitted_classes: [],
  permitted_symbols: [],
  aliases: false,
)
puts JSON.generate(document)
`;

async function loadConfig() {
  const { stdout } = await execFileAsync(
    "ruby",
    ["-ryaml", "-rjson", "-e", rubyYamlToJson, configPath],
    { maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

test("Dependabot covers every repository package-manager surface", async () => {
  const config = await loadConfig();
  assert.equal(config.version, 2);
  const byEcosystem = new Map(config.updates.map((update) => [update["package-ecosystem"], update]));
  assert.deepEqual([...byEcosystem.keys()].sort(), ["github-actions", "gomod", "npm", "uv"]);
  assert.deepEqual(byEcosystem.get("npm").directories, [
    "/",
    "/packaging/distribution/api-native",
    "/packaging/distribution/playwright-mcp",
  ]);
  assert.equal(byEcosystem.get("uv").directory, "/workers/automation");
  assert.equal(byEcosystem.get("gomod").directory, "/launcher");
  assert.equal(byEcosystem.get("github-actions").directory, "/");
});

test("Dependabot staggers bounded ecosystem batches and keeps majors separate", async () => {
  const config = await loadConfig();
  const days = [];
  for (const update of config.updates) {
    assert.equal(update.schedule.interval, "weekly");
    assert.equal(update.schedule.time, "04:00");
    assert.equal(update.schedule.timezone, "Europe/Madrid");
    days.push(update.schedule.day);
    assert.equal(update["open-pull-requests-limit"], 3);
    assert.deepEqual(update.cooldown, {
      "semver-major-days": 30,
      "semver-minor-days": 7,
      "semver-patch-days": 3,
    });
    const groups = Object.values(update.groups);
    assert.ok(groups.length > 0);
    for (const group of groups) {
      assert.deepEqual(group["update-types"], ["minor", "patch"]);
      assert.ok(!group["update-types"].includes("major"));
    }
  }
  assert.deepEqual(days, ["tuesday", "wednesday", "thursday", "friday"]);
});

test("React and its renderer/types update atomically", async () => {
  const config = await loadConfig();
  const npm = config.updates.find((update) => update["package-ecosystem"] === "npm");
  assert.deepEqual(npm.groups["react-runtime"].patterns, [
    "react",
    "react-dom",
    "@types/react",
    "@types/react-dom",
  ]);
});
