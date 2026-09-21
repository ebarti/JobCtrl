import assert from 'node:assert/strict';
import test from 'node:test';
import { labelsForIssue, triageIssue } from './issue-triage.mjs';

const safety = '### Data-safety confirmation\n\n- [x] I have not included secrets, tokens, private data, worker logs, browser profiles, or APIs.';

function bodyWithArea(area, extra = '') {
  return `### Affected area\n\n${area}\n\n### What happened?\n\n${extra}\n\n${safety}`;
}

function githubFixture({ existingDefinitions = [], createRace = [] } = {}) {
  const definitions = new Set(existingDefinitions);
  const races = new Set(createRace);
  const calls = [];
  const github = {
    rest: {
      issues: {
        async getLabel(input) {
          calls.push(['getLabel', input]);
          if (!definitions.has(input.name)) throw Object.assign(new Error('missing'), { status: 404 });
          return { data: { name: input.name } };
        },
        async createLabel(input) {
          calls.push(['createLabel', input]);
          if (races.has(input.name)) {
            definitions.add(input.name);
            throw Object.assign(new Error('created concurrently'), { status: 409 });
          }
          definitions.add(input.name);
          return { data: input };
        },
        async addLabels(input) {
          calls.push(['addLabels', input]);
          return { data: input.labels };
        },
      },
    },
  };
  return { github, calls, definitions };
}

test('project progress labels are never inferred and closed issues are inert', () => {
  assert.deepEqual(labelsForIssue({ state: 'open', title: '[Bug]: broken', body: '', labels: [] }), ['type: bug']);
  assert.deepEqual(labelsForIssue({ state: 'closed', title: '[Bug]: broken', body: '', labels: [] }), []);
  assert.equal(labelsForIssue({ state: 'open', title: '[Bug]: broken', body: '', labels: [] }).some(label => label.startsWith('status: ')), false);
});

test('form and bounded conventional titles infer at most one type', () => {
  const cases = [
    ['[Bug]: broken', 'type: bug'],
    ['feat(web): add filter', 'type: feature'],
    ['docs!: correct setup', 'type: documentation'],
    ['test(api): missing proof', 'type: test'],
    ['chore(deps): update lock', 'type: maintenance'],
    ['design: compare storage options', 'type: investigation'],
  ];
  for (const [title, expected] of cases) {
    const result = labelsForIssue({ state: 'open', title, body: '', labels: [] });
    assert.equal(result.filter(label => label.startsWith('type: ')).length, 1);
    assert.ok(result.includes(expected), title);
  }
  for (const title of ['prefix fix: broken', 'fix no colon', 'feature: broad alias', '[maintenance]: task']) {
    assert.equal(labelsForIssue({ state: 'open', title, body: '', labels: [] }).some(label => label.startsWith('type: ')), false, title);
  }
});

test('existing manual type and area labels are authoritative', () => {
  const labels = labelsForIssue({
    state: 'open',
    title: '[Bug]: web failure',
    body: bodyWithArea('Web app', 'API key exposed in output'),
    labels: ['type: investigation', 'area: api', 'priority: P2'],
  });
  assert.deepEqual(labels, ['privacy: review-needed']);
});

test('structured area is conservative and conflicting fields are left unchanged', () => {
  assert.deepEqual(labelsForIssue({ state: 'open', title: '[Bug]: first screen', body: bodyWithArea('Setup or install'), labels: ['type: bug'] }), ['area: setup']);
  for (const body of [
    '### Area\n\nUnsure',
    '### Area\n\nDocumentation\n\n### Area\n\nWeb app',
    '### Area\n\nDocumentation\n\n### Affected area\n\nWeb app',
  ]) {
    assert.deepEqual(labelsForIssue({ state: 'open', title: 'Unclassified request', body, labels: [] }), []);
  }
});

test('privacy requires a sensitive object and explicit exposure semantics', () => {
  for (const title of [
    'fix(security): resolve credential dependency advisories',
    '[Bug]: vulnerability in dependency',
    'chore: rotate API tokens',
    'docs: document credential migration',
    '[Bug]: API token is not exposed',
    '[Bug]: no credentials were logged',
  ]) {
    assert.equal(labelsForIssue({ state: 'open', title, body: safety, labels: [] }).includes('privacy: review-needed'), false, title);
  }
  for (const subject of [
    'API token exposed',
    'Private data visible',
    'Credential shown in error',
    'API key in output',
    'Secret leaked into logs',
  ]) {
    assert.ok(labelsForIssue({ state: 'open', title: `[Bug]: ${subject}`, body: bodyWithArea('TypeScript API'), labels: [] }).includes('privacy: review-needed'), subject);
  }
});

test('existing manual privacy and release flags are never removed on edits', () => {
  assert.deepEqual(labelsForIssue({
    state: 'open',
    title: 'chore: ordinary maintenance',
    body: '',
    labels: ['type: maintenance', 'privacy: review-needed', 'release: possible-blocker'],
  }), []);
});

test('security-contact form keeps security and privacy routing', () => {
  assert.deepEqual(labelsForIssue({ state: 'open', title: '[Security contact]: request', body: safety, labels: [] }), [
    'type: security-contact',
    'area: security',
    'privacy: review-needed',
  ]);
});

test('release label requires its exact checked form field', () => {
  for (const checked of [' ', 'x']) {
    const labels = labelsForIssue({
      state: 'open',
      title: '[QA]: regression',
      body: `### Regression surface\n\nApply Review\n\n### Release impact\n\n- [${checked}] This appears to block a public release, source install, or documented first-run flow.`,
      labels: [],
    });
    assert.equal(labels.includes('release: possible-blocker'), checked === 'x');
  }
});

test('opened, edited and reopened handling creates only missing declarations and converges', async () => {
  const fixture = githubFixture({ existingDefinitions: ['type: bug'], createRace: ['area: api'] });
  const issue = {
    number: 77,
    state: 'open',
    title: '[Bug]: API key exposed in output',
    body: bodyWithArea('TypeScript API'),
    labels: [],
  };

  const opened = await triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issue });
  assert.deepEqual(opened.additions, ['type: bug', 'area: api', 'privacy: review-needed']);
  assert.equal(opened.ensured.find(item => item.name === 'area: api').raced, true);
  assert.equal(fixture.calls.some(([method]) => method === 'updateLabel'), false);

  issue.labels.push(...opened.additions.map(name => ({ name })));
  const edited = await triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issue });
  const reopened = await triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issue });
  assert.deepEqual(edited.additions, []);
  assert.deepEqual(reopened.additions, []);
  assert.equal(fixture.calls.filter(([method]) => method === 'addLabels').length, 1);
});

test('closed handling performs zero API writes', async () => {
  const fixture = githubFixture();
  const result = await triageIssue({
    github: fixture.github,
    owner: 'ebarti',
    repo: 'jobctrl',
    issue: { number: 78, state: 'closed', title: '[Bug]: closed', body: '', labels: [] },
  });
  assert.deepEqual(result, { additions: [], ensured: [] });
  assert.deepEqual(fixture.calls, []);
});
