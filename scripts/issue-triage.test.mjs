import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { labelsForIssue, triageIssue } from './issue-triage.mjs';

const safety = '### Data-safety confirmation\n\n- [x] I have not included secrets, tokens, private data, worker logs, browser profiles, or APIs.';

function bodyWithArea(area, extra = '') {
  return `### Affected area\n\n${area}\n\n### What happened?\n\n${extra}\n\n${safety}`;
}

function githubFixture({
  issue,
  existingDefinitions = [],
  createRace = [],
  onGetLabel,
  onBeforeAddLabels,
  onAddLabels,
  provenance = 'bot-owned',
} = {}) {
  const definitions = new Set(existingDefinitions);
  const races = new Set(createRace);
  const calls = [];
  const events = [];
  let nextEventId = 1;
  let currentIssue = structuredClone(issue);
  const recordLabel = (name, actor = { login: 'github-actions[bot]', type: 'Bot' }) => {
    events.push({ id: nextEventId++, event: 'labeled', label: { name }, actor });
  };
  const github = {
    async paginate(method, input) {
      calls.push(['paginate', input]);
      const response = await method(input);
      return response.data;
    },
    rest: {
      issues: {
        async get(input) {
          calls.push(['get', input]);
          return { data: structuredClone(currentIssue) };
        },
        async getLabel(input) {
          calls.push(['getLabel', input]);
          onGetLabel?.(currentIssue, input);
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
          onBeforeAddLabels?.(currentIssue, input, { recordLabel });
          for (const name of input.labels) {
            if (currentIssue.labels.some(label => (label.name ?? label) === name)) continue;
            currentIssue.labels.push({ name });
            if (provenance === 'bot-owned') recordLabel(name);
            else if (provenance === 'ambiguous') {
              recordLabel(name);
              recordLabel(name);
            }
          }
          onAddLabels?.(currentIssue, input, { recordLabel });
          return { data: input.labels };
        },
        async listEvents(input) {
          calls.push(['listEvents', input]);
          return { data: structuredClone(events) };
        },
        async removeLabel(input) {
          calls.push(['removeLabel', input]);
          currentIssue.labels = currentIssue.labels.filter(label => (label.name ?? label) !== input.name);
          return { data: null };
        },
      },
    },
  };
  return {
    github,
    calls,
    definitions,
    events,
    get issue() { return currentIssue; },
    editIssue(changes) { Object.assign(currentIssue, structuredClone(changes)); },
  };
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
    '[Bug]: no API key appears in logs',
    '[Bug]: API key does not appear in logs',
    '[Bug]: API key was never in logs',
    '[Bug]: This change does not expose API keys',
    '[Bug]: We do not expose credentials',
    '[Bug]: Never expose tokens in logs',
    '[Bug]: The fix never leaks private data',
    '[Bug]: This change does not currently expose API keys',
    '[Bug]: We do not accidentally leak credentials',
    'chore: update credential output formatting',
    'fix: credential response schema validation',
    'docs: describe API token output fields',
    'chore: credential logging maintenance',
    'fix: API token response logging',
  ]) {
    assert.equal(labelsForIssue({ state: 'open', title, body: safety, labels: [] }).includes('privacy: review-needed'), false, title);
  }
  for (const subject of [
    'API token exposed',
    'Private data visible',
    'Credential shown in error',
    'API key in output',
    'Secret leaked into logs',
    'API token exposed without redaction',
    'API key appears in logs',
    'This change exposes API keys',
    'We expose credentials',
    'This change exposes tokens in logs',
    'The fix leaks private data',
    'Credentials were copied and exposed in logs',
    'API keys, unfortunately, were logged',
    'This change does not expose API keys although credentials were logged',
  ]) {
    assert.ok(labelsForIssue({ state: 'open', title: `[Bug]: ${subject}`, body: bodyWithArea('TypeScript API'), labels: [] }).includes('privacy: review-needed'), subject);
  }
});

test('production triage adapter respects contextual exposure negation in both phrase orders', async () => {
  const cases = [
    ['API token is not exposed', false],
    ['No credentials were logged', false],
    ['API key does not appear in logs', false],
    ['This change does not expose API keys', false],
    ['We do not expose credentials', false],
    ['Never expose tokens in logs', false],
    ['The fix never leaks private data', false],
    ['This change does not currently expose API keys', false],
    ['We do not accidentally leak credentials', false],
    ["This change doesn't expose API keys", false],
    ["We don't leak credentials", false],
    ["The migration didn't expose tokens", false],
    ["API key wasn't logged", false],
    ["Credentials weren't exposed", false],
    ["API keys weren't accidentally logged", false],
    ["API key doesn't currently appear in logs", false],
    ["API keys weren't in logs", false],
    ['Credentials were never publicly exposed', false],
    ['API token is exposed', true],
    ['Credentials were logged', true],
    ['API key appears in logs', true],
    ['This change exposes API keys', true],
    ['We expose credentials', true],
    ['This change exposes tokens in logs', true],
    ['The fix leaks private data', true],
    ['Credentials were copied and exposed in logs', true],
    ['API keys, unfortunately, were logged', true],
    ['This change does not expose API keys although credentials were logged', true],
    ['API keys were not exposed though credentials were logged', true],
    ['API keys were not exposed while credentials were logged', true],
    ['API keys were not exposed but credentials were logged', true],
    ['API keys were not exposed; credentials were logged', true],
    ['API token is not exposed and API key appears in logs', true],
  ];
  let number = 200;
  for (const [subject, expectedPrivacy] of cases) {
    const issue = {
      number: number++,
      state: 'open',
      title: `[Bug]: ${subject}`,
      body: bodyWithArea('TypeScript API'),
      labels: [{ name: 'priority: P2' }],
    };
    const fixture = githubFixture({
      issue,
      existingDefinitions: ['type: bug', 'area: api', 'privacy: review-needed'],
    });
    const result = await triageIssue({
      github: fixture.github,
      owner: 'ebarti',
      repo: 'jobctrl',
      issueNumber: issue.number,
    });
    assert.equal(result.additions.includes('privacy: review-needed'), expectedPrivacy, subject);
    assert.equal(fixture.issue.labels.some(label => label.name === 'privacy: review-needed'), expectedPrivacy, subject);
    assert.equal(fixture.calls.filter(([method]) => method === 'addLabels').length, 1, subject);
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
  const issue = {
    number: 77,
    state: 'open',
    title: '[Bug]: API key exposed in output',
    body: bodyWithArea('TypeScript API'),
    labels: [],
  };
  const fixture = githubFixture({ issue, existingDefinitions: ['type: bug'], createRace: ['area: api'] });

  const opened = await triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: issue.number });
  assert.deepEqual(opened.additions, ['type: bug', 'area: api', 'privacy: review-needed']);
  assert.equal(opened.ensured.find(item => item.name === 'area: api').raced, true);
  assert.equal(fixture.calls.some(([method]) => method === 'updateLabel'), false);

  const edited = await triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: issue.number });
  const reopened = await triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: issue.number });
  assert.deepEqual(edited.additions, []);
  assert.deepEqual(reopened.additions, []);
  assert.equal(fixture.calls.filter(([method]) => method === 'addLabels').length, 1);
});

test('closed handling performs zero API writes', async () => {
  const issue = { number: 78, state: 'closed', title: '[Bug]: closed', body: '', labels: [] };
  const fixture = githubFixture({ issue });
  const result = await triageIssue({
    github: fixture.github,
    owner: 'ebarti',
    repo: 'jobctrl',
    issueNumber: issue.number,
  });
  assert.deepEqual(result, { additions: [], ensured: [] });
  assert.equal(fixture.calls.filter(([method]) => ['createLabel', 'addLabels'].includes(method)).length, 0);
});

test('overlapping opened and edited runs serialize without accumulating conflicting type and area labels', async () => {
  const issue = {
    number: 79,
    state: 'open',
    title: '[Bug]: API failure',
    body: bodyWithArea('TypeScript API'),
    labels: [],
  };
  const fixture = githubFixture({
    issue,
    existingDefinitions: ['type: bug', 'area: api', 'type: feature', 'area: web'],
  });
  const originalAdd = fixture.github.rest.issues.addLabels;
  fixture.github.rest.issues.addLabels = async input => {
    const result = await originalAdd(input);
    fixture.editIssue({ title: '[Feature]: web filter', body: bodyWithArea('Web app') });
    return result;
  };

  const opened = triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: issue.number });
  const edited = triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: issue.number });
  await Promise.all([opened, edited]);

  assert.deepEqual(fixture.issue.labels.map(label => label.name).filter(name => name.startsWith('type: ')), ['type: feature']);
  assert.deepEqual(fixture.issue.labels.map(label => label.name).filter(name => name.startsWith('area: ')), ['area: web']);
  assert.equal(fixture.calls.filter(([method]) => method === 'addLabels').length, 2);
  assert.deepEqual(fixture.calls.filter(([method]) => method === 'removeLabel').map(([, input]) => input.name), ['type: bug', 'area: api']);
});

test('a close during triage is re-read immediately before assignment', async () => {
  const issue = { number: 80, state: 'open', title: '[Bug]: closes while running', body: '', labels: [] };
  const fixture = githubFixture({
    issue,
    existingDefinitions: ['type: bug'],
    onGetLabel(currentIssue) { currentIssue.state = 'closed'; },
  });
  const result = await triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: issue.number });
  assert.deepEqual(result.additions, []);
  assert.equal(fixture.calls.filter(([method]) => method === 'addLabels').length, 0);
});

test('a close at the add-label boundary compensates only labels added by that run', async () => {
  const issue = {
    number: 81,
    state: 'open',
    title: '[Bug]: closes while labels are added',
    body: bodyWithArea('Web app'),
    labels: [{ name: 'priority: P1' }, { name: 'origin: manual' }],
  };
  const fixture = githubFixture({
    issue,
    existingDefinitions: ['type: bug', 'area: web'],
    onAddLabels(currentIssue) { currentIssue.state = 'closed'; },
  });
  const result = await triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: issue.number });
  assert.deepEqual(result.compensated, ['type: bug', 'area: web']);
  assert.deepEqual(fixture.issue.labels.map(label => label.name).sort(), ['origin: manual', 'priority: P1']);
  assert.deepEqual(fixture.calls.filter(([method]) => method === 'removeLabel').map(([, input]) => input.name), ['type: bug', 'area: web']);
  assert.equal(fixture.calls.filter(([method]) => method === 'listEvents').length, 2);
});

test('same-label human race is preserved because the new assignment is not bot-owned', async () => {
  const issue = {
    number: 82,
    state: 'open',
    title: '[Bug]: human wins label race',
    body: '',
    labels: [{ name: 'priority: P1' }],
  };
  const fixture = githubFixture({
    issue,
    existingDefinitions: ['type: bug'],
    onBeforeAddLabels(currentIssue, _input, { recordLabel }) {
      currentIssue.labels.push({ name: 'type: bug' });
      recordLabel('type: bug', { login: 'maintainer', type: 'User' });
      currentIssue.state = 'closed';
    },
  });
  const result = await triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: issue.number });
  assert.deepEqual(result.compensated, []);
  assert.deepEqual(result.compensationSkipped, ['type: bug']);
  assert.deepEqual(fixture.issue.labels.map(label => label.name).sort(), ['priority: P1', 'type: bug']);
  assert.equal(fixture.calls.some(([method]) => method === 'removeLabel'), false);
});

test('missing or ambiguous label provenance fails safe without manual or unrelated label loss', async () => {
  for (const provenance of ['missing', 'ambiguous']) {
    const issue = {
      number: provenance === 'missing' ? 83 : 84,
      state: 'open',
      title: '[Bug]: provenance cannot prove ownership',
      body: '',
      labels: [{ name: 'priority: P1' }, { name: 'origin: manual' }],
    };
    const fixture = githubFixture({
      issue,
      existingDefinitions: ['type: bug'],
      provenance,
      onAddLabels(currentIssue) { currentIssue.state = 'closed'; },
    });
    const result = await triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: issue.number });
    assert.deepEqual(result.compensated, [], provenance);
    assert.deepEqual(result.compensationSkipped, ['type: bug'], provenance);
    assert.deepEqual(fixture.issue.labels.map(label => label.name).sort(), ['origin: manual', 'priority: P1', 'type: bug'], provenance);
    assert.equal(fixture.calls.some(([method]) => method === 'removeLabel'), false, provenance);
  }
});

test('workflow serializes each issue and passes only the issue number to fresh triage reads', async () => {
  const workflow = await readFile(new URL('../.github/workflows/issue-triage.yml', import.meta.url), 'utf8');
  assert.match(workflow, /group: issue-triage-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.issue\.number \|\| inputs\.issue_number \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /const automationLogin = 'github-actions\[bot\]'/);
  assert.match(workflow, /triageIssue\(\{ github, owner, repo, issueNumber, automationLogin \}\)/);
  assert.doesNotMatch(workflow, /const \{ data: issue \}/);
});
