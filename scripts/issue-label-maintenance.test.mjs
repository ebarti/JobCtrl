import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LABEL_CATALOGUE } from './issue-label-catalogue.mjs';
import {
  buildCleanupPlan,
  runCatalogueSync,
  runCleanup,
} from './issue-label-maintenance.mjs';

const repository = 'ebarti/jobctrl';

function projectItem(number, statuses, id = `project-${number}`) {
  return { id, content: { number, repository: 'ebarti/JobCtrl', state: 'open' }, statuses };
}

function issue(number, labels, extra = {}) {
  return {
    number,
    state: 'open',
    title: `Issue ${number}`,
    html_url: `https://github.com/ebarti/JobCtrl/issues/${number}`,
    labels: labels.map(name => ({ name })),
    assignees: [],
    ...extra,
  };
}

function tempSnapshot(directory, name) {
  return path.join(directory, name);
}

test('catalogue sync reports drift in dry-run and applies only create/update operations', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jobctrl-label-catalogue-'));
  const labels = Object.entries(LABEL_CATALOGUE)
    .filter(([name]) => name !== 'type: test')
    .map(([name, definition]) => ({ name, ...definition }));
  labels.find(label => label.name === 'type: bug').description = 'stale';
  labels.push({ name: 'status: needs triage', color: 'fbca04', description: 'historic' });
  const writes = [];
  const adapter = {
    async listLabelsPage(page) {
      return page === 1 ? labels : [];
    },
    async createLabel(definition) {
      writes.push(['create', definition.name]);
      labels.push({ ...definition });
    },
    async updateLabel(name, definition) {
      writes.push(['update', name]);
      Object.assign(labels.find(label => label.name === name), definition);
    },
  };

  const preview = await runCatalogueSync({
    adapter,
    snapshotPath: tempSnapshot(directory, 'preview.json'),
    now: () => new Date('2026-09-21T10:00:00Z'),
  });
  assert.deepEqual(preview.plan.create.map(label => label.name), ['type: test']);
  assert.deepEqual(preview.plan.update.map(label => label.name), ['type: bug']);
  assert.deepEqual(preview.plan.retired, ['status: needs triage']);
  assert.equal(preview.execution.attemptedWrites, 0);
  assert.deepEqual(writes, []);

  const applied = await runCatalogueSync({
    adapter,
    apply: true,
    snapshotPath: tempSnapshot(directory, 'apply.json'),
    now: () => new Date('2026-09-21T10:01:00Z'),
  });
  assert.deepEqual(writes, [['create', 'type: test'], ['update', 'type: bug']]);
  assert.equal(applied.execution.failed.length, 0);
  assert.equal(applied.after.find(label => label.name === 'status: needs triage').description, 'historic');
});

test('cleanup dry-run paginates, preserves unrelated state and skips unverifiable status removals', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jobctrl-label-cleanup-'));
  const fillers = Array.from({ length: 100 }, (_, index) => issue(index + 1000, ['custom: keep']));
  const relevant = [
    issue(1, ['status: in progress', 'bug', 'custom: keep'], { assignees: [{ login: 'maintainer' }] }),
    issue(2, ['status: needs triage']),
    issue(3, ['documentation', 'type: bug']),
    issue(4, ['status: backlog']),
    issue(5, ['status: in review']),
    issue(6, ['status: needs triage'], { pull_request: { url: 'https://api.github.com/pulls/6' } }),
    issue(8, ['status: needs validation', 'execution: not admitted']),
  ];
  const projectsFirst = Array.from({ length: 100 }, (_, index) => projectItem(index + 1000, ['Backlog']));
  const projectsSecond = [
    projectItem(1, ['In Progress']),
    projectItem(4, ['Backlog'], 'project-4a'),
    projectItem(4, ['Backlog'], 'project-4b'),
    projectItem(5, []),
    projectItem(6, ['Backlog']),
    projectItem(8, ['Backlog']),
  ];
  const calls = { open: [], project: [], writes: [] };
  const adapter = {
    async listOpenItemsPage(page) {
      calls.open.push(page);
      return page === 1 ? fillers : page === 2 ? relevant : [];
    },
    async getItem() { throw new Error('unexpected getItem'); },
    async listProjectItemsPage(_projectNumber, cursor) {
      calls.project.push(cursor);
      return cursor === null
        ? { nodes: projectsFirst, hasNextPage: true, nextCursor: 'next' }
        : { nodes: projectsSecond, hasNextPage: false, nextCursor: null };
    },
    async addLabels() { calls.writes.push('add'); },
    async removeLabel() { calls.writes.push('remove'); },
  };

  const snapshotPath = tempSnapshot(directory, 'preview.json');
  const result = await runCleanup({ adapter, repository, snapshotPath, now: () => new Date('2026-09-21T11:00:00Z') });
  assert.deepEqual(calls.open, [1, 2]);
  assert.deepEqual(calls.project, [null, 'next']);
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(result.before, result.after);
  assert.equal(result.execution.attemptedWrites, 0);

  const one = result.plan.mutations.find(mutation => mutation.number === 1);
  assert.deepEqual(one.add, ['type: bug']);
  assert.deepEqual(one.remove.sort(), ['bug', 'status: in progress']);
  const six = result.plan.mutations.find(mutation => mutation.number === 6);
  assert.equal(six.kind, 'pull_request');
  assert.deepEqual(six.remove, ['status: needs triage']);
  assert.ok(result.plan.skips.some(skip => skip.number === 2 && skip.reason === 'project-membership-missing'));
  assert.ok(result.plan.skips.some(skip => skip.number === 3 && skip.reason === 'legacy-type-conflicts-with-manual-type'));
  assert.ok(result.plan.skips.some(skip => skip.number === 4 && skip.reason === 'project-membership-ambiguous'));
  assert.ok(result.plan.skips.some(skip => skip.number === 5 && skip.reason === 'project-status-missing-or-ambiguous'));
  assert.equal(result.plan.mutations.some(mutation => mutation.number === 8), false);
  assert.equal(result.plan.skips.some(skip => skip.number === 8), false);
  const beforeOne = result.before.find(item => item.number === 1);
  assert.deepEqual(beforeOne.assignees, ['maintainer']);
  assert.ok(beforeOne.labels.includes('custom: keep'));
  assert.equal(JSON.parse(await readFile(snapshotPath, 'utf8')).execution.attemptedWrites, 0);
});

test('reviewed corrections are explicit and enforce expected state and Project status', () => {
  const items = [
    issue(888, ['privacy: review-needed', 'origin: owner backlog']),
    issue(945, ['status: needs triage', 'privacy: review-needed'], { state: 'closed' }),
  ];
  const reviewedCorrections = [
    { number: 888, label: 'privacy: review-needed', expectedState: 'open', reason: 'Public content describes credential maintenance, not exposure.' },
    { number: 945, label: 'status: needs triage', expectedState: 'closed', expectedProjectStatus: 'Done', reason: 'Completed item retains Project Done.' },
    { number: 945, label: 'privacy: review-needed', expectedState: 'closed', expectedProjectStatus: 'Done', reason: 'Public content contains no exposure report.' },
  ];
  const result = buildCleanupPlan({
    items,
    projectItems: [projectItem(888, ['Backlog']), projectItem(945, ['Done'])],
    repository,
    reviewedCorrections,
  });
  assert.deepEqual(result.mutations.find(mutation => mutation.number === 888).remove, ['privacy: review-needed']);
  assert.deepEqual(result.mutations.find(mutation => mutation.number === 945).remove.sort(), ['privacy: review-needed', 'status: needs triage']);
  assert.equal(result.mutations.find(mutation => mutation.number === 888).remove.includes('origin: owner backlog'), false);
});

test('partial mutation failure is retained and a rerun converges', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jobctrl-label-rerun-'));
  const state = issue(7, ['bug', 'custom: keep'], { assignees: [{ login: 'owner' }] });
  let failRemoval = true;
  const adapter = {
    async listOpenItemsPage(page) { return page === 1 ? [state] : []; },
    async getItem() { throw new Error('unexpected getItem'); },
    async listProjectItemsPage() { return { nodes: [], hasNextPage: false, nextCursor: null }; },
    async addLabels(_number, labels) {
      for (const name of labels) if (!state.labels.some(label => label.name === name)) state.labels.push({ name });
    },
    async removeLabel(_number, name) {
      if (failRemoval) {
        failRemoval = false;
        throw new Error('injected remove failure');
      }
      state.labels = state.labels.filter(label => label.name !== name);
    },
  };

  const first = await runCleanup({ adapter, repository, apply: true, snapshotPath: tempSnapshot(directory, 'first.json') });
  assert.equal(first.execution.failed.length, 1);
  assert.match(first.execution.failed[0].error, /injected remove failure/);
  assert.deepEqual(state.labels.map(label => label.name).sort(), ['bug', 'custom: keep', 'type: bug']);

  const second = await runCleanup({ adapter, repository, apply: true, snapshotPath: tempSnapshot(directory, 'second.json') });
  assert.equal(second.execution.failed.length, 0);
  assert.deepEqual(second.plan.mutations[0].add, []);
  assert.deepEqual(second.plan.mutations[0].remove, ['bug']);
  assert.deepEqual(state.labels.map(label => label.name).sort(), ['custom: keep', 'type: bug']);
  assert.deepEqual(state.assignees, [{ login: 'owner' }]);
});

test('failed canonical-label addition never removes the legacy label', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jobctrl-label-add-failure-'));
  const state = issue(9, ['enhancement', 'custom: keep']);
  const adapter = {
    async listOpenItemsPage(page) { return page === 1 ? [state] : []; },
    async getItem() { throw new Error('unexpected getItem'); },
    async listProjectItemsPage() { return { nodes: [], hasNextPage: false, nextCursor: null }; },
    async addLabels() { throw new Error('injected add failure'); },
    async removeLabel() { throw new Error('remove must not run'); },
  };
  const result = await runCleanup({ adapter, repository, apply: true, snapshotPath: tempSnapshot(directory, 'failure.json') });
  assert.equal(result.execution.failed.length, 1);
  assert.deepEqual(result.execution.skipped, [{ number: 9, action: 'remove', label: 'enhancement', reason: 'required-label-addition-failed' }]);
  assert.deepEqual(state.labels.map(label => label.name).sort(), ['custom: keep', 'enhancement']);
});
