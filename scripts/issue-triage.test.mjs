import assert from 'node:assert/strict';
import test from 'node:test';
import { labelsForIssue } from './issue-triage.mjs';

const safety = '### Data-safety confirmation\n\n- [x] I have not included secrets, tokens, private data, worker logs, browser profiles, or APIs.';

test('explicit Documentation and Setup selections ignore contextual and safety words', () => {
  for (const [selection, expected] of [['Documentation', 'docs'], ['Setup or install', 'setup']]) {
    const labels = labelsForIssue({title: '[Bug]: first useful screen', labels: ['type: bug'], body: `### Affected area\n\n${selection}\n\n### What happened?\n\njobctrl doctor opens the web API.\n\n${safety}`});
    assert.deepEqual(labels, ['status: needs triage', `area: ${expected}`]);
  }
});

test('security contact retains its declared security and privacy routing', () => {
  assert.deepEqual(labelsForIssue({title: '[Security contact]: request', body: safety}), ['status: needs triage', 'type: security-contact', 'area: security', 'privacy: review-needed']);
});

test('ordinary reports with sensitive titles retain privacy review without scanning boilerplate', () => {
  for (const subject of ['API token exposed', 'Private data visible', 'Credential shown in error', 'API key in output', 'Secrets exposed in logs', 'Credentials shown in error', 'API tokens visible', 'API keys exposed', 'Vulnerabilities reported']) {
    assert.deepEqual(labelsForIssue({title: `[bug]: ${subject}`, body: `### Affected area\n\nTypeScript API\n\n${safety}`, labels: []}), ['status: needs triage', 'type: bug', 'area: api', 'privacy: review-needed']);
  }
  assert.deepEqual(labelsForIssue({title: '[bug]: API error', body: `### Affected area\n\nTypeScript API\n\n${safety}`, labels: []}), ['status: needs triage', 'type: bug', 'area: api']);
});

test('only an explicitly checked release impact adds a release label', () => {
  for (const checked of [' ', 'x']) {
    const labels = labelsForIssue({title: '[QA]: regression', body: `### Regression surface\n\nApply Review\n\n### Release impact\n\n- [${checked}] This appears to block a public release, source install, or documented first-run flow.\n- [x] I have not included secrets.`});
    assert.equal(labels.includes('release: possible-blocker'), checked === 'x');
    assert.equal(labels.includes('privacy: review-needed'), false);
    assert.ok(labels.includes('area: web'));
  }
});

test('blank issues use a conservative title fallback and retain existing labels', () => {
  assert.deepEqual(labelsForIssue({title: 'Docs: fix README command', body: safety}), ['status: needs triage', 'area: docs']);
  assert.deepEqual(labelsForIssue({title: 'A problem', body: safety, labels: ['status: accepted', 'area: api']}), []);
});

test('unknown, duplicate and ambiguous selections remain for explicit triage', () => {
  for (const body of ['### Area\n\nUnsure', '### Area\n\nDocumentation\n\n### Area\n\nWeb app', '### Area\n\nDocumentation\n\n### Affected area\n\nWeb app']) {
    assert.deepEqual(labelsForIssue({title: 'Docs problem', body}), ['status: needs triage']);
  }
});

// Full-form regression fixtures contributed by Harsh Raj Singhania in
// https://github.com/ebarti/JobCtrl/pull/878; adapted to labelsForIssue.
const DOCS_FIXTURE = {
  title: "[Docs]: first-run screen is hard to find",
  body: `### Page or file
docs/user/getting-started.md

### Documentation problem
Confusing instructions

### What should change?
Point newcomers at the first useful screen after install.

### Validation context
I ran \`jobctrl doctor\` and opened the web dashboard. The CLI printed a first useful screen hint.

### Data-safety confirmation
- [x] I have not included secrets, private profile data, resumes, generated application materials, raw logs, browser profiles, SQLite databases, or local paths.
`,
};

const SETUP_FIXTURE = {
  title: "[Bug]: source install fails on first run",
  body: `### Affected area
Setup or install

### What happened?
\`pnpm dev:setup\` fails before the first useful screen appears.

### Expected behavior
Setup completes and jobctrl doctor reports a healthy environment.

### Reproduction steps
1. Run pnpm dev:setup
2. Run jobctrl doctor
3. Open the dashboard

### Data-safety confirmation
- [x] I have not included secrets, private profile data, resumes, generated application materials, raw logs, browser profiles, SQLite databases, or local paths.
`,
};

const SECURITY_CONTACT_FIXTURE = {
  title: "[Security contact]: request private reporting path",
  body: `### Confirmation
- [x] I need a private contact path for a possible vulnerability and have not included vulnerability details in this public issue.
- [x] I have not included secrets, private profile data, resumes, generated application materials, raw logs, browser profiles, SQLite databases, local paths, or exploit details.

### Minimal public summary
local API boundary
`,
};

const BLANK_ISSUE_FIXTURE = {
  title: "Worker Temporal workflow never starts",
  body: `The python worker and Temporal automation engine stay idle after install.
I also checked an API route / JSON-RPC endpoint on the server.
`,
};

test("documentation form ignores contextual and safety-boilerplate routing words", () => {
  assert.deepEqual(labelsForIssue(DOCS_FIXTURE), [
    "status: needs triage",
    "type: documentation",
    "area: docs",
  ]);
});

test("setup form routes only to its structured area without inferring release impact", () => {
  assert.deepEqual(labelsForIssue(SETUP_FIXTURE), [
    "status: needs triage",
    "type: bug",
    "area: setup",
  ]);
});

test("security-contact form retains its declared security and privacy routing", () => {
  assert.deepEqual(labelsForIssue(SECURITY_CONTACT_FIXTURE), [
    "status: needs triage",
    "type: security-contact",
    "area: security",
    "privacy: review-needed",
  ]);
});

test("unstructured body mentions do not route worker, API or install issues", () => {
  assert.deepEqual(labelsForIssue(BLANK_ISSUE_FIXTURE), ["status: needs triage"]);
});
