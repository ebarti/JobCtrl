import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("public onboarding leads with bundled acquisition and keeps source advanced", async () => {
  const gettingStarted = await read("docs/user/getting-started.md");
  const readme = await read("README.md");

  for (const document of [gettingStarted, readme]) {
    assert.match(document, /curl -fsSL https:\/\/jobctrl\.dev\/install\.sh \| sh/);
    assert.match(document, /brew install ebarti\/tap\/jobctrl/);
    assert.match(document, /jobctrl start/);
  }

  const installer = gettingStarted.indexOf("### Recommended: bundled installer");
  const homebrew = gettingStarted.indexOf("### Homebrew");
  const source = gettingStarted.indexOf("### Build and run from source");
  assert.ok(installer >= 0 && installer < homebrew && homebrew < source);
  assert.match(gettingStarted, /Only this option requires Git/);
  assert.doesNotMatch(gettingStarted, /^## \d+\. Source-Checkout Requirements$/m);
  assert.match(
    gettingStarted,
    /For the bundled installer or Homebrew: an Apple-silicon Mac running macOS 15\s+or newer\./,
  );
  const normalizedOnboarding = [gettingStarted, readme].map((document) =>
    document.replace(/\s+/g, " "),
  );
  for (const document of normalizedOnboarding) {
    assert.match(
      document,
      /Native Windows is not yet a supported public installation path\./i,
    );
    assert.doesNotMatch(
      document,
      /Windows compatibility currently uses this source-development path until a signed Windows bundle is published\./i,
    );
  }
  assert.match(gettingStarted, /stay on your computer/);
  assert.doesNotMatch(gettingStarted, /stay on your Mac/);
  assert.doesNotMatch(gettingStarted, /You do \*\*not\*\* need to install Git/);

  const publicCopy = [
    readme,
    gettingStarted,
    await read("ROADMAP.md"),
    await read("docs/local-development.md"),
    await read("docs/architecture/index.md"),
    await read("docs/architecture/runtime.md"),
    await read("docs/user/normal-flows.md"),
    await read("docs/user/configuration.md"),
    await read("docs/user/data-and-safety.md"),
  ].join("\n");
  assert.doesNotMatch(
    publicCopy,
    /not published yet|not public yet|only public path|current public path|after the first signed bundled release|public channel remains blocked|unpublished bundled product/i,
  );

  const claimsLedger = await read("docs/claims-ledger.md");
  assert.match(claimsLedger, /\| CL-082 \|[^\n]+\| Roadmap \|/);
  assert.match(claimsLedger, /> \*\*Launch-cutover draft\.\*\*/);
  assert.match(claimsLedger, /must not be\n> merged or deployed while CL-082 remains `Roadmap`/);
});

test("comparison omits the annotated recommendation and methodology sections", async () => {
  const comparison = await read("docs/comparison.md");

  assert.doesNotMatch(comparison, /^## Which operating style fits\?$/m);
  assert.doesNotMatch(comparison, /^## Method and limitations$/m);
  assert.doesNotMatch(comparison, /^### Reading the statuses$/m);
  assert.doesNotMatch(comparison, /jh-compare-fit-grid/);
  assert.match(comparison, /^## Appendix: evidence-backed capability matrix$/m);
});

test("launch provider guidance requires one of Codex, Claude, or Google", async () => {
  const readme = await read("README.md");
  const gettingStarted = await read("docs/user/getting-started.md");
  const configuration = await read("docs/user/configuration.md");
  const envExample = await read(".env.example");
  const security = await read("docs/user/security.md");
  const dataAndSafety = await read("docs/user/data-and-safety.md");
  const publicProviderCopy = [
    readme,
    gettingStarted,
    configuration,
    envExample,
    security,
    dataAndSafety,
    await read("docs/architecture/runtime.md"),
    await read("docs/api/complete-contract.md"),
  ].join("\n");

  assert.match(gettingStarted, /One ready provider is sufficient/);
  assert.match(configuration, /^### Codex$/m);
  assert.match(configuration, /^### Claude$/m);
  assert.match(configuration, /^### Google$/m);
  for (const document of [
    readme,
    gettingStarted,
    configuration,
    envExample,
    security,
    dataAndSafety,
  ]) {
    assert.match(document, /authenticated Codex CLI/i);
  }

  const readmeConfigurationStart = readme.indexOf("## Configuration");
  const readmeDevelopmentStart = readme.indexOf(
    "## Development",
    readmeConfigurationStart,
  );
  assert.ok(
    readmeConfigurationStart >= 0 &&
      readmeDevelopmentStart > readmeConfigurationStart,
  );
  const readmeConfiguration = readme.slice(
    readmeConfigurationStart,
    readmeDevelopmentStart,
  );
  assert.doesNotMatch(
    `${readmeConfiguration}\n${gettingStarted}`,
    /auth\.json|setup --launch-logins|isolated (?:Codex )?home|copy-once|fallback target-home/i,
  );

  const codexStart = configuration.indexOf("### Codex");
  const claudeStart = configuration.indexOf("### Claude", codexStart);
  assert.ok(codexStart >= 0 && claudeStart > codexStart);
  const codexSection = configuration.slice(codexStart, claudeStart);
  assert.match(codexSection, /already authenticated Codex CLI/);
  assert.doesNotMatch(codexSection, /codex login --with-api-key/);
  assert.doesNotMatch(
    codexSection,
    /CODEX_HOME|codex_home|auth\.json|setup --launch-logins|isolated (?:Codex )?home|fallback target-home/i,
  );
  const simpleSetupCopy = `${readmeConfiguration}\n${gettingStarted}\n${codexSection}`;
  assert.doesNotMatch(
    simpleSetupCopy,
    /CODEX_HOME|codex_home|auth\.json|setup --launch-logins|isolated (?:Codex )?home|fallback target-home/i,
  );
  assert.doesNotMatch(
    simpleSetupCopy,
    /\b(?:Codex (?:CLI )?login|credentials?|authentication) (?:copy|copying|import|importing|staging)\b|\b(?:copy|copying|import|importing) (?:an? )?(?:existing |valid |normal )*(?:Codex (?:CLI )?login|credentials?|authentication)\b|\b(?:copy-once|reusable-login importer)\b/i,
  );
  for (const document of [readme, security, dataAndSafety]) {
    assert.match(document, /codex_home/);
    assert.match(document, /workspace\//);
    assert.match(document, /(?:once|one-time)/i);
    assert.match(document, /never overwrit/i);
  }
  assert.match(configuration, /CLAUDE_CODE_USE_BEDROCK/);
  assert.match(configuration, /CLAUDE_CODE_USE_ANTHROPIC_AWS/);
  assert.match(configuration, /CLAUDE_CODE_USE_VERTEX/);
  assert.match(configuration, /CLAUDE_CODE_USE_FOUNDRY/);
  assert.match(configuration, /GOOGLE_APPLICATION_CREDENTIALS/);
  assert.doesNotMatch(publicProviderCopy, /LLM_URL|LLM_API_KEY/);
  assert.doesNotMatch(gettingStarted, /local OpenAI-compatible/i);
  assert.doesNotMatch(readme, /OpenAI-backed scoring|general LLM access.*OPENAI_API_KEY/i);
});

test("configuration docs match current routes, storage, and opt-in integrations", async () => {
  const readme = await read("README.md");
  const configuration = await read("docs/user/configuration.md");
  const dataAndSafety = await read("docs/user/data-and-safety.md");
  const security = await read("docs/user/security.md");
  const storage = await read("docs/architecture/storage.md");
  const observability = await read("docs/architecture/observability.md");
  const completeApi = await read("docs/api/complete-contract.md");
  const envExample = await read(".env.example");
  const normalizedConfiguration = configuration.replace(/\s+/g, " ");
  const normalizedApi = completeApi.replace(/\s+/g, " ");
  const startHere = configuration.slice(
    configuration.indexOf("## Start Here"),
    configuration.indexOf("### How a setting becomes effective"),
  );

  assert.match(normalizedConfiguration, /daily LLM budget is stored in `dashboard\.json`/i);
  assert.doesNotMatch(configuration, /daily LLM budget is a preference stored in SQLite/i);
  assert.match(normalizedApi, /scheduling mutation boundary; `\/v1\/settings` does not own discovery cadence/i);
  assert.match(normalizedApi, /configured `dailyBudgetUsd` from `dashboard\.json`/i);

  for (const [label, route] of [
    ["Profile", "/profile"],
    ["Preferences", "/preferences"],
    ["Discovery", "/discovery"],
    ["Settings → General", "/settings"],
    ["Settings → Credentials", "/settings/credentials"],
    ["Settings → Model selection", "/settings/models"],
    ["Settings → Browser & extension", "/settings/browser"],
  ]) {
    assert.ok(startHere.includes(`**${label}**`));
    assert.ok(startHere.includes(`\`${route}\``));
    assert.ok(!configuration.includes(`](${route})`));
  }
  assert.match(configuration, /jobctrl capability enable auto-apply-browser/);
  assert.match(configuration, /environment compatibility override → saved UI value → built-in default/);
  assert.match(configuration, /worker activity slots show desired versus active values/);
  assert.match(configuration, /The path is write-only and is not shown again/);
  assert.match(configuration, /Rotating the pairing token takes effect immediately/);
  assert.match(configuration, /not a provider connection/i);

  for (const document of [readme, dataAndSafety, security, storage]) {
    assert.match(document, /dashboard\.json/);
    assert.match(document, /codex_home/);
    assert.match(document, /browser-capabilities\.json/);
  }

  assert.doesNotMatch(envExample, /CHROME_PATH|JOBCTRL_API_HOST|JOBCTRL_API_PORT|VITE_GOOGLE_MAPS_API_KEY|TEMPORAL_ADDRESS/);
  assert.match(envExample, /docs\/local-development\.md/);
  assert.match(envExample, /^# CAPSOLVER_API_KEY=$/m);
  assert.match(configuration, /gmail\.readonly/);
  assert.match(configuration, /gmail\.send/);
  assert.match(configuration, /Removing only the local token.*does not revoke/is);

  for (const document of [readme, configuration, dataAndSafety, security, observability]) {
    assert.match(document, /metadata-only/i);
  }
  assert.doesNotMatch(configuration, /prompts and completions are exported/i);
});

test("runtime overrides stay in contributor documentation", async () => {
  const configuration = await read("docs/user/configuration.md");
  const localDevelopment = await read("docs/local-development.md");
  const expectedRuntimeOverrides = [
    ["`JOBCTRL_DIR`", "`~/.jobctrl`"],
    ["`JOBCTRL_DB_PATH`", "`$JOBCTRL_DIR/jobctrl.db`"],
    ["`JOBCTRL_DASHBOARD_CONFIG_PATH`", "`$JOBCTRL_DIR/dashboard.json`"],
    ["`JOBCTRL_API_HOST`", "`127.0.0.1`"],
    ["`JOBCTRL_API_PORT` / `PORT`", "`8766`"],
    ["`JOBCTRL_API_ALLOW_REMOTE_BIND`", "unset"],
    ["`JOBCTRL_WEB_PORT`", "`5173`"],
    ["`JOBCTRL_DOCS_PORT`", "`4174`"],
    ["`JOBCTRL_DEMO_WEB_PORT`", "`5174`"],
    ["`JOBCTRL_DEMO_API_PORT`", "`8787`"],
    ["`JOBCTRL_DEMO_STATE_DIR`", "`.dev/demo/wrangler`"],
    ["`VITE_JOBCTRL_API_BASE_URL`", "proxied `/v1`"],
    ["`JOBCTRL_TEMPORAL_DB`", "`.dev/temporal/temporal.db`"],
    ["`TEMPORAL_ADDRESS`", "`localhost:7233`"],
    ["`TEMPORAL_NAMESPACE`", "`default`"],
    ["`JOBCTRL_MAX_CONCURRENT_ACTIVITIES`", "`4`"],
    ["`JOBCTRL_API_SSE_POLL_MS`", "`250`"],
    ["`VITE_DEV_API_PROXY_TARGET`", "`http://127.0.0.1:8766`"],
    ["`VITE_DEMO_API_PROXY_TARGET`", "launcher-managed"],
    ["`VITE_GOOGLE_MAPS_API_KEY`", "unset"],
  ];
  const developerOnlyLocalDataVariables = [
    "JOBCTRL_DB_PATH",
    "JOBCTRL_DASHBOARD_CONFIG_PATH",
    "JOBCTRL_API_HOST",
    "JOBCTRL_API_PORT",
    "JOBCTRL_API_ALLOW_REMOTE_BIND",
    "JOBCTRL_WEB_PORT",
    "JOBCTRL_DOCS_PORT",
    "JOBCTRL_DEMO_WEB_PORT",
    "JOBCTRL_DEMO_API_PORT",
    "JOBCTRL_DEMO_STATE_DIR",
    "VITE_JOBCTRL_API_BASE_URL",
    "JOBCTRL_TEMPORAL_DB",
    "TEMPORAL_ADDRESS",
    "TEMPORAL_NAMESPACE",
    "JOBCTRL_API_SSE_POLL_MS",
    "VITE_DEV_API_PROXY_TARGET",
    "VITE_DEMO_API_PROXY_TARGET",
  ];

  assert.doesNotMatch(configuration, /^## Core Runtime$/m);
  assert.doesNotMatch(configuration, /One isolated development\/QA stack/);

  const localDataStart = configuration.indexOf("## Local Data");
  const nextSection = configuration.indexOf("\n## ", localDataStart + 1);
  assert.ok(localDataStart >= 0 && nextSection > localDataStart);
  const localData = configuration.slice(localDataStart, nextSection);
  for (const variable of developerOnlyLocalDataVariables) {
    assert.ok(!localData.includes(`\`${variable}\``));
  }
  assert.match(localData, /`~\/.jobctrl`/);
  assert.match(localData, /set\s+`JOBCTRL_DIR`\s+before starting JobCtrl/i);
  assert.match(localData, /\[Data, Privacy & Safety\]\(data-and-safety\.md\)/);
  assert.match(
    localData,
    /\[Local Development → Runtime Overrides\]\(\.\.\/local-development\.md#runtime-overrides\)/,
  );
  assert.doesNotMatch(localData, /^\| Variable \|/m);
  assert.match(localDevelopment, /^### Runtime Overrides$/m);

  const runtimeOverridesStart = localDevelopment.indexOf(
    "### Runtime Overrides",
  );
  const nextRuntimeSubsection = localDevelopment.indexOf(
    "\n### ",
    runtimeOverridesStart + 1,
  );
  assert.ok(
    runtimeOverridesStart >= 0 &&
      nextRuntimeSubsection > runtimeOverridesStart,
  );
  const runtimeOverrides = localDevelopment.slice(
    runtimeOverridesStart,
    nextRuntimeSubsection,
  );
  const tableLines = runtimeOverrides
    .split(/\r?\n/)
    .filter((line) => /^\s*\|/.test(line));
  const parseTableRow = (line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  assert.equal(tableLines.length, expectedRuntimeOverrides.length + 2);
  assert.deepEqual(parseTableRow(tableLines[0]), [
    "Variable",
    "Default",
    "What it does",
  ]);
  assert.deepEqual(parseTableRow(tableLines[1]), ["---", "---", "---"]);
  const runtimeRows = tableLines.slice(2).map(parseTableRow);
  assert.deepEqual(
    runtimeRows.map(([variable, defaultValue]) => [variable, defaultValue]),
    expectedRuntimeOverrides,
  );

  const descriptions = new Map(
    runtimeRows.map(([variable, , description]) => [variable, description]),
  );
  assert.match(
    descriptions.get("`JOBCTRL_DB_PATH`"),
    /Python worker ignores it.*desynchronizes the API from the worker.*prefer `JOBCTRL_DIR`/i,
  );
  assert.match(
    descriptions.get("`JOBCTRL_API_HOST`"),
    /Non-loopback hosts require explicit opt-in/i,
  );
  assert.match(
    descriptions.get("`JOBCTRL_API_ALLOW_REMOTE_BIND`"),
    /Set to `1`, `true`, or `yes` to allow non-loopback API binding.*expose private local data/i,
  );
});
