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
