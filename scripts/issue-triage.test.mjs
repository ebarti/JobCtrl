import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureDeclaredLabel, labelsForIssue, triageIssue } from './issue-triage.mjs';

const safety = '### Data-safety confirmation\n\n- [x] I have not included secrets, tokens, private data, worker logs, browser profiles, or APIs.';

function bodyWithArea(area, extra = '') {
  return `### Affected area\n\n${area}\n\n### What happened?\n\n${extra}\n\n${safety}`;
}

function githubFixture({ issue, existingDefinitions = [], createRace = [], onGetLabel, onBeforeAddLabels } = {}) {
  const definitions = new Set(existingDefinitions);
  const races = new Set(createRace);
  const calls = [];
  let currentIssue = structuredClone(issue);
  const github = {
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
          onBeforeAddLabels?.(currentIssue, input);
          for (const name of input.labels) {
            if (!currentIssue.labels.some(label => (label.name ?? label) === name)) {
              currentIssue.labels.push({ name });
            }
          }
          return { data: input.labels };
        },
      },
    },
  };
  return {
    github,
    calls,
    definitions,
    get issue() { return currentIssue; },
    editIssue(changes) { Object.assign(currentIssue, structuredClone(changes)); },
  };
}

test('Project Status is the sole progress source and closed issues are inert', () => {
  const open = labelsForIssue({ state: 'open', title: '[Bug]: broken', body: '', labels: [] });
  assert.deepEqual(open, ['type: bug']);
  assert.equal(open.some(label => label.startsWith('status: ')), false);
  assert.deepEqual(labelsForIssue({ state: 'closed', title: '[Bug]: broken', body: '', labels: [] }), []);
});

test('form prefixes and bounded conventional titles infer at most one type', () => {
  const cases = [
    ['[Bug]: broken', 'type: bug'],
    ['[Feature]: add filter', 'type: feature'],
    ['[QA]: regression', 'type: qa-regression'],
    ['[Docs]: fix setup', 'type: documentation'],
    ['[Question]: setup', 'type: question'],
    ['feat(web): add filter', 'type: feature'],
    ['docs!: correct setup', 'type: documentation'],
    ['test(api): missing proof', 'type: test'],
    ['chore(deps): update lock', 'type: maintenance'],
    ['design: compare storage options', 'type: investigation'],
  ];
  for (const [title, expected] of cases) {
    const result = labelsForIssue({ state: 'open', title, body: '', labels: [] });
    assert.deepEqual(result.filter(label => label.startsWith('type: ')), [expected], title);
  }
  for (const title of ['prefix fix: broken', 'fix no colon', 'feature: broad alias', '[maintenance]: task']) {
    assert.equal(labelsForIssue({ state: 'open', title, body: '', labels: [] }).some(label => label.startsWith('type: ')), false, title);
  }
});

test('existing manual type and area labels are authoritative', () => {
  assert.deepEqual(labelsForIssue({
    state: 'open',
    title: '[Bug]: web failure',
    body: bodyWithArea('Web app'),
    labels: ['type: investigation', 'area: api', 'priority: P2'],
  }), []);
});

test('area classification uses one explicit supported form choice and never issue prose', () => {
  assert.deepEqual(labelsForIssue({
    state: 'open', title: '[Bug]: first screen', body: bodyWithArea('Setup or install'), labels: ['type: bug'],
  }), ['area: setup']);
  for (const body of [
    'Documentation and setup are mentioned in prose.',
    '### Area\n\nUnsure',
    '### Area\n\nDocumentation\n\n### Area\n\nWeb app',
    '### Area\n\nDocumentation\n\n### Affected area\n\nWeb app',
  ]) {
    assert.deepEqual(labelsForIssue({ state: 'open', title: 'Docs setup problem', body, labels: [] }), []);
  }
});

const ARBITRARY_PRIVACY_PROSE = [
  "API token exposed|Private data visible|Credential shown in error|API key in output|Secret leaked into logs|API token exposed without redaction",
  "API key appears in logs|This change exposes API keys|We expose credentials|This change exposes tokens in logs|The fix leaks private data|Credentials were copied and exposed in logs",
  "API keys, unfortunately, were logged|This change does not expose API keys although credentials were logged|API token is not exposed|No credentials were logged|No API key appears in logs|API key does not appear in logs",
  "API key was never in logs|This change does not expose API keys|We do not expose credentials|Never expose tokens in logs|The fix never leaks private data|This change does not currently expose API keys",
  "We do not accidentally leak credentials|This change doesn't expose API keys|We don't leak credentials|The migration didn't expose tokens|API key wasn't logged|Credentials weren't exposed",
  "API keys weren't accidentally logged|API key doesn't currently appear in logs|API keys weren't in logs|Credentials were never publicly exposed|No API keys or credentials were exposed|Credentials were not exposed or logged",
  "API keys cannot be exposed|API keys will not be exposed|API keys are no longer logged|Neither API keys nor credentials were exposed|API keys were not exposed|API keys were not accidentally exposed",
  "No API keys were exposed|Credentials were not exposed|API keys are not being exposed|The service cannot expose API keys|The service will not expose API keys|The service is not exposing API keys or credentials",
  "The service no longer logs API keys|API keys were not, unfortunately, exposed|The service can't expose API keys|The service won't expose API keys|The service isn't exposing API keys|The service does not expose or log credentials",
  "The service does not expose credentials or log tokens|Credentials were not exposed and were not logged|Credential logging maintenance|API token response logging|Credential display formatting|Credential publishing workflow",
  "Publishing credential documentation|Displaying credential schema|The service publishes credential documentation|The service displays credential fields|The service logs API token responses|The service publishes credential and token documentation",
  "API token is exposed|Credentials were logged|API keys were not exposed though credentials were logged|API keys were not exposed while credentials were logged|API keys were not exposed but credentials were logged|API keys were not exposed; credentials were logged",
  "API token is not exposed and API key appears in logs|API keys were not exposed but were logged|API keys weren't exposed but appeared in logs|The service is exposing API keys|The service is showing API keys|The service is displaying API keys",
  "The service is revealing API keys|The service is leaking API keys|The service is logging API keys|The service is printing API keys|The service is publishing API keys|The service is disclosing API keys",
  "The service is committing API keys|The service is pasting API keys|The service is rendering API keys|API keys are visible|API key exposure|API key visibility",
  "API keys appear in logs|API keys were exposed|API keys were accidentally exposed|API keys or credentials were exposed|Credentials were exposed|Credentials were exposed and logged",
  "Credentials were not exposed and were logged|API keys are being exposed|The service is exposing API keys and credentials|The service exposes and logs credentials|No exposed API keys|API keys have no exposure",
  "The service mustn't expose API keys|API keys were not exposed nor credentials were logged|Neither API keys were exposed nor credentials were logged|Credential leak|API key leak|Secret leak",
  "Password leak|Credentials leak|API keys leak|Secrets leak|Passwords leak|Vulnerabilities reported",
].flatMap(group => group.split('|'));

test('arbitrary title and body prose never infers privacy review', () => {
  for (const prose of ARBITRARY_PRIVACY_PROSE) {
    for (const issue of [
      { state: 'open', title: `[Bug]: ${prose}`, body: bodyWithArea('TypeScript API'), labels: [] },
      { state: 'open', title: '[Bug]: synthetic report', body: bodyWithArea('TypeScript API', prose), labels: [] },
    ]) {
      assert.equal(labelsForIssue(issue).includes('privacy: review-needed'), false, prose);
    }
  }
  assert.deepEqual(labelsForIssue({
    state: 'open', title: 'ordinary maintenance', body: '', labels: ['type: maintenance', 'privacy: review-needed'],
  }), []);
});

test('security-contact type is the only automatic privacy route', () => {
  assert.deepEqual(labelsForIssue({ state: 'open', title: '[Security contact]: request', body: safety, labels: [] }), [
    'type: security-contact',
    'area: security',
    'privacy: review-needed',
  ]);
  assert.deepEqual(labelsForIssue({ state: 'open', title: 'private path', body: safety, labels: ['type: security-contact'] }), [
    'area: security',
    'privacy: review-needed',
  ]);
  assert.deepEqual(labelsForIssue({
    state: 'open', title: '[Security contact]: request', body: safety,
    labels: ['type: security-contact', 'area: security', 'privacy: review-needed'],
  }), []);
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

test('catalogue lookup creates only missing declared labels and tolerates a create race', async () => {
  const fixture = githubFixture({
    issue: { number: 1, state: 'open', title: '', body: '', labels: [] },
    existingDefinitions: ['type: bug'],
    createRace: ['area: api'],
  });
  assert.deepEqual(await ensureDeclaredLabel({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', name: 'type: bug' }), {
    name: 'type: bug', created: false,
  });
  assert.equal(fixture.calls.some(([method]) => method === 'createLabel'), false);
  assert.deepEqual(await ensureDeclaredLabel({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', name: 'area: api' }), {
    name: 'area: api', created: false, raced: true,
  });
  await assert.rejects(
    ensureDeclaredLabel({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', name: 'status: needs triage' }),
    /Refusing to create undeclared label/,
  );
});

test('opened, edited and reopened handling converges without rewriting definitions', async () => {
  const issue = {
    number: 77,
    state: 'open',
    title: '[Bug]: synthetic failure',
    body: bodyWithArea('TypeScript API'),
    labels: [],
  };
  const fixture = githubFixture({ issue, existingDefinitions: ['type: bug'], createRace: ['area: api'] });

  const opened = await triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: issue.number });
  assert.deepEqual(opened.additions, ['type: bug', 'area: api']);
  assert.equal(opened.ensured.find(item => item.name === 'area: api').raced, true);
  const edited = await triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: issue.number });
  const reopened = await triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: issue.number });
  assert.deepEqual(edited.additions, []);
  assert.deepEqual(reopened.additions, []);
  assert.equal(fixture.calls.filter(([method]) => method === 'addLabels').length, 1);
  assert.equal(fixture.calls.some(([method]) => method === 'updateLabel'), false);
});

test('closed handling performs zero API writes and a close before assignment stays inert', async () => {
  const closedFixture = githubFixture({
    issue: { number: 78, state: 'closed', title: '[Bug]: closed', body: '', labels: [] },
  });
  assert.deepEqual(await triageIssue({
    github: closedFixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: 78,
  }), { additions: [], ensured: [] });
  assert.equal(closedFixture.calls.filter(([method]) => ['createLabel', 'addLabels'].includes(method)).length, 0);

  const closingFixture = githubFixture({
    issue: { number: 79, state: 'open', title: '[Bug]: closing', body: '', labels: [] },
    existingDefinitions: ['type: bug'],
    onGetLabel(issue) { issue.state = 'closed'; },
  });
  const result = await triageIssue({ github: closingFixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: 79 });
  assert.deepEqual(result.additions, []);
  assert.equal(closingFixture.calls.filter(([method]) => method === 'addLabels').length, 0);
});

test('overlapping issue events serialize and never accumulate conflicting classifications', async () => {
  let edited = false;
  const fixture = githubFixture({
    issue: {
      number: 80,
      state: 'open',
      title: '[Bug]: API failure',
      body: bodyWithArea('TypeScript API'),
      labels: [],
    },
    existingDefinitions: ['type: bug', 'area: api', 'type: feature', 'area: web'],
    onBeforeAddLabels(issue) {
      if (edited) return;
      edited = true;
      issue.title = '[Feature]: web filter';
      issue.body = bodyWithArea('Web app');
    },
  });

  await Promise.all([
    triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: 80 }),
    triageIssue({ github: fixture.github, owner: 'ebarti', repo: 'jobctrl', issueNumber: 80 }),
  ]);

  const names = fixture.issue.labels.map(label => label.name);
  assert.deepEqual(names.filter(name => name.startsWith('type: ')), ['type: bug']);
  assert.deepEqual(names.filter(name => name.startsWith('area: ')), ['area: api']);
  assert.equal(fixture.calls.filter(([method]) => method === 'addLabels').length, 1);
});
