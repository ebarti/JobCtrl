import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LABEL_CATALOGUE } from './issue-label-catalogue.mjs';
import { buildCleanupPlan, main, runCatalogueSync, runCleanup } from './issue-label-maintenance.mjs';

const repository = 'ebarti/jobctrl';
const fixedNow = () => new Date('2026-09-21T12:00:00Z');

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

function cleanupAdapter(state, options = {}) {
  return {
    async listOpenItemsPage(page) {
      if (options.failRefresh && options.reads === 2) throw new Error('injected refresh failure');
      options.reads = (options.reads ?? 0) + 1;
      return page === 1 ? [state] : [];
    },
    async getItem() { throw new Error('unexpected getItem'); },
    async listProjectItemsPage() { return { nodes: [], hasNextPage: false, nextCursor: null }; },
    async addLabels(_number, labels) {
      await options.beforeAdd?.();
      if (options.failAddition) throw new Error('injected add failure');
      for (const name of labels) if (!state.labels.some(label => label.name === name)) state.labels.push({ name });
    },
    async removeLabel(_number, name) {
      if (options.failRemovalOnce) {
        options.failRemovalOnce = false;
        throw new Error('injected remove failure');
      }
      state.labels = state.labels.filter(label => label.name !== name);
    },
  };
}

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
  const result = await runCleanup({ adapter, repository, snapshotPath, now: fixedNow });
  assert.deepEqual(calls.open, [1, 2]);
  assert.deepEqual(calls.project, [null, 'next']);
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(result.before, result.after);
  assert.equal(result.execution.attemptedWrites, 0);
  assert.match(result.planId, /^[a-f0-9]{64}$/);
  const one = result.plan.mutations.find(mutation => mutation.number === 1);
  assert.deepEqual(one.add, ['type: bug']);
  assert.deepEqual(one.remove.sort(), ['bug', 'status: in progress']);
  assert.equal(result.plan.mutations.find(mutation => mutation.number === 6).kind, 'pull_request');
  assert.ok(result.plan.skips.some(skip => skip.number === 2 && skip.reason === 'project-membership-missing'));
  assert.ok(result.plan.skips.some(skip => skip.number === 3 && skip.reason === 'legacy-type-conflicts-with-manual-type'));
  assert.ok(result.plan.skips.some(skip => skip.number === 4 && skip.reason === 'project-membership-ambiguous'));
  assert.ok(result.plan.skips.some(skip => skip.number === 5 && skip.reason === 'project-status-missing-or-ambiguous'));
  assert.equal(result.plan.mutations.some(mutation => mutation.number === 8), false);
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

test('cleanup apply is bound to reviewed state and fails closed after relevant item drift', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jobctrl-label-drift-'));
  const state = issue(7, ['bug', 'custom: keep']);
  const writes = [];
  const adapter = cleanupAdapter(state);
  adapter.addLabels = async (...args) => { writes.push(['add', ...args]); };
  adapter.removeLabel = async (...args) => { writes.push(['remove', ...args]); };
  const preview = await runCleanup({ adapter, repository, snapshotPath: tempSnapshot(directory, 'preview.json') });
  state.labels.push({ name: 'type: feature' });
  await assert.rejects(runCleanup({
    adapter,
    repository,
    apply: true,
    reviewedSnapshot: preview,
    reviewedPlanId: preview.planId,
    snapshotPath: tempSnapshot(directory, 'apply.json'),
  }), /Reviewed plan drifted before apply/);
  assert.deepEqual(writes, []);
});

test('catalogue apply is bound to reviewed definitions and fails closed after label drift', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jobctrl-catalogue-drift-'));
  const labels = Object.entries(LABEL_CATALOGUE)
    .filter(([name]) => name !== 'type: test')
    .map(([name, definition]) => ({ name, ...definition }));
  const writes = [];
  const adapter = {
    async listLabelsPage(page) { return page === 1 ? labels : []; },
    async createLabel(definition) { writes.push(['create', definition]); },
    async updateLabel(name, definition) { writes.push(['update', name, definition]); },
  };
  const preview = await runCatalogueSync({ adapter, snapshotPath: tempSnapshot(directory, 'preview.json') });
  labels.push({ name: 'type: test', ...LABEL_CATALOGUE['type: test'] });
  await assert.rejects(runCatalogueSync({
    adapter,
    apply: true,
    reviewedSnapshot: preview,
    reviewedPlanId: preview.planId,
    snapshotPath: tempSnapshot(directory, 'apply.json'),
  }), /Reviewed plan drifted before apply/);
  assert.deepEqual(writes, []);
});

test('partial mutation failure is journaled and a newly reviewed rerun converges', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jobctrl-label-rerun-'));
  const state = issue(7, ['bug', 'custom: keep'], { assignees: [{ login: 'owner' }] });
  const options = { failRemovalOnce: true };
  const adapter = cleanupAdapter(state, options);
  const firstPreview = await runCleanup({ adapter, repository, snapshotPath: tempSnapshot(directory, 'first-preview.json') });
  const first = await runCleanup({
    adapter, repository, apply: true, reviewedSnapshot: firstPreview, reviewedPlanId: firstPreview.planId,
    snapshotPath: tempSnapshot(directory, 'first-apply.json'),
  });
  assert.equal(first.execution.failed.length, 1);
  assert.match(first.execution.failed[0].error, /injected remove failure/);
  assert.deepEqual(first.execution.journal.map(entry => entry.status), ['succeeded', 'failed']);
  assert.deepEqual(state.labels.map(label => label.name).sort(), ['bug', 'custom: keep', 'type: bug']);
  const secondPreview = await runCleanup({ adapter, repository, snapshotPath: tempSnapshot(directory, 'second-preview.json') });
  const second = await runCleanup({
    adapter, repository, apply: true, reviewedSnapshot: secondPreview, reviewedPlanId: secondPreview.planId,
    snapshotPath: tempSnapshot(directory, 'second-apply.json'),
  });
  assert.equal(second.execution.failed.length, 0);
  assert.deepEqual(second.plan.mutations[0].add, []);
  assert.deepEqual(second.plan.mutations[0].remove, ['bug']);
  assert.deepEqual(state.labels.map(label => label.name).sort(), ['custom: keep', 'type: bug']);
  assert.deepEqual(state.assignees, [{ login: 'owner' }]);
});

test('failed canonical-label addition never removes the legacy label', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jobctrl-label-add-failure-'));
  const state = issue(9, ['enhancement', 'custom: keep']);
  const adapter = cleanupAdapter(state, { failAddition: true });
  const preview = await runCleanup({ adapter, repository, snapshotPath: tempSnapshot(directory, 'preview.json') });
  const result = await runCleanup({
    adapter, repository, apply: true, reviewedSnapshot: preview, reviewedPlanId: preview.planId,
    snapshotPath: tempSnapshot(directory, 'failure.json'),
  });
  assert.equal(result.execution.failed.length, 1);
  assert.deepEqual(result.execution.skipped, [{ number: 9, action: 'remove', label: 'enhancement', reason: 'required-label-addition-failed' }]);
  assert.deepEqual(state.labels.map(label => label.name).sort(), ['custom: keep', 'enhancement']);
});

test('preflight and attempted writes remain durable when the post-write refresh fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jobctrl-label-refresh-'));
  const state = issue(10, ['question']);
  const options = { failRefresh: true, reads: 0 };
  const adapter = cleanupAdapter(state, options);
  const preview = await runCleanup({ adapter, repository, snapshotPath: tempSnapshot(directory, 'preview.json') });
  const applyPath = tempSnapshot(directory, 'apply.json');
  let observedBeforeWrite;
  options.beforeAdd = async () => { observedBeforeWrite = JSON.parse(await readFile(applyPath, 'utf8')); };
  const result = await runCleanup({
    adapter, repository, apply: true, reviewedSnapshot: preview, reviewedPlanId: preview.planId, snapshotPath: applyPath,
  });
  assert.equal(result.phase, 'after-read-failed');
  assert.equal(observedBeforeWrite.planId, preview.planId);
  assert.equal(observedBeforeWrite.execution.journal[0].status, 'attempting');
  assert.match(result.afterReadError, /injected refresh failure/);
  assert.deepEqual(result.execution.journal.map(entry => entry.status), ['succeeded', 'succeeded']);
  const retained = JSON.parse(await readFile(applyPath, 'utf8'));
  assert.equal(retained.phase, 'after-read-failed');
  assert.equal(retained.planId, preview.planId);
  assert.equal(retained.after, null);
  assert.match(retained.execution.failed.at(-1).error, /injected refresh failure/);
});

function githubFetchFixture() {
  const state = {
    labels: Object.entries(LABEL_CATALOGUE)
      .filter(([name]) => name !== 'type: test')
      .map(([name, definition]) => ({ name, ...definition })),
    issues: [issue(41, ['status: in progress', 'bug', 'custom: keep'], { assignees: [{ login: 'maintainer' }] })],
    calls: [], raceCreate: true, failBugRemovalOnce: true,
  };
  state.labels.find(label => label.name === 'type: bug').description = 'stale description';
  const response = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });

  async function fetchImpl(url, options = {}) {
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    state.calls.push({ method, url, body });
    const parsed = new URL(url);
    if (parsed.pathname === '/graphql') {
      const cursor = body.variables.cursor;
      const nodes = cursor === null
        ? [{ id: 'other-repository', content: { number: 999, state: 'OPEN', repository: { nameWithOwner: 'elsewhere/repo' } }, fieldValues: { nodes: [] } }]
        : [{ id: 'project-41', content: { number: 41, state: 'OPEN', repository: { nameWithOwner: 'ebarti/JobCtrl' } }, fieldValues: { nodes: [{ name: 'In Progress', field: { name: 'Status' } }] } }];
      return response({ data: { repository: { owner: { projectV2: { items: {
        pageInfo: cursor === null ? { hasNextPage: true, endCursor: 'cursor-2' } : { hasNextPage: false, endCursor: null }, nodes,
      } } } } } });
    }
    if (parsed.pathname === '/repos/ebarti/jobctrl/labels' && method === 'GET') return response(state.labels);
    if (parsed.pathname === '/repos/ebarti/jobctrl/labels' && method === 'POST') {
      if (state.raceCreate) {
        state.raceCreate = false;
        state.labels.push({ ...body });
        return response({ message: 'already exists' }, 409);
      }
      state.labels.push({ ...body });
      return response(body, 201);
    }
    if (parsed.pathname.startsWith('/repos/ebarti/jobctrl/labels/') && method === 'PATCH') {
      const name = decodeURIComponent(parsed.pathname.split('/').at(-1));
      Object.assign(state.labels.find(label => label.name === name), body);
      return response({ name, ...body });
    }
    if (parsed.pathname === '/repos/ebarti/jobctrl/issues' && method === 'GET') return response(state.issues);
    const issueLabels = parsed.pathname.match(/^\/repos\/ebarti\/jobctrl\/issues\/(\d+)\/labels$/);
    if (issueLabels && method === 'POST') {
      const target = state.issues.find(item => item.number === Number(issueLabels[1]));
      for (const name of body.labels) if (!target.labels.some(label => label.name === name)) target.labels.push({ name });
      return response(target.labels);
    }
    const issueLabel = parsed.pathname.match(/^\/repos\/ebarti\/jobctrl\/issues\/(\d+)\/labels\/(.+)$/);
    if (issueLabel && method === 'DELETE') {
      const name = decodeURIComponent(issueLabel[2]);
      if (name === 'bug' && state.failBugRemovalOnce) {
        state.failBugRemovalOnce = false;
        return response({ message: 'injected failure' }, 500);
      }
      const target = state.issues.find(item => item.number === Number(issueLabel[1]));
      target.labels = target.labels.filter(label => label.name !== name);
      return response(null, 204);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }
  return { state, fetchImpl };
}

test('real CLI adapter preserves reviewed plans across REST and GraphQL pagination, failures, races, and convergence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jobctrl-label-cli-'));
  const fixture = githubFetchFixture();
  const dependencies = { fetchImpl: fixture.fetchImpl, env: { GH_TOKEN: 'fixture-token' }, stdout: { write() {} }, now: fixedNow };
  const mutationCalls = () => fixture.state.calls.filter(call => call.url !== 'https://api.github.com/graphql' && ['POST', 'PATCH', 'DELETE'].includes(call.method));

  const cataloguePreviewPath = tempSnapshot(directory, 'catalogue-preview.json');
  const cataloguePreview = await main(['catalogue', '--snapshot', cataloguePreviewPath], dependencies);
  assert.deepEqual(cataloguePreview.snapshot.plan.create.map(label => label.name), ['type: test']);
  assert.deepEqual(cataloguePreview.snapshot.plan.update.map(label => label.name), ['type: bug']);
  assert.deepEqual(mutationCalls(), []);
  const catalogueApply = await main([
    'catalogue', '--apply', '--reviewed-snapshot', cataloguePreviewPath, '--plan-id', cataloguePreview.snapshot.planId,
    '--snapshot', tempSnapshot(directory, 'catalogue-apply.json'),
  ], dependencies);
  assert.equal(catalogueApply.exitCode, 0);
  assert.equal(catalogueApply.snapshot.execution.succeeded.find(entry => entry.action === 'create').raced, true);
  const catalogueMutations = mutationCalls();
  assert.deepEqual(catalogueMutations[0], {
    method: 'POST', url: 'https://api.github.com/repos/ebarti/jobctrl/labels',
    body: { name: 'type: test', ...LABEL_CATALOGUE['type: test'] },
  });
  assert.deepEqual(catalogueMutations[1], {
    method: 'PATCH', url: 'https://api.github.com/repos/ebarti/jobctrl/labels/type%3A%20bug',
    body: LABEL_CATALOGUE['type: bug'],
  });

  const cleanupPreviewPath = tempSnapshot(directory, 'cleanup-preview.json');
  const mutationsBeforeCleanupPreview = mutationCalls().length;
  const cleanupPreview = await main(['cleanup', '--snapshot', cleanupPreviewPath], dependencies);
  assert.deepEqual(cleanupPreview.snapshot.plan.mutations[0].add, ['type: bug']);
  assert.deepEqual(cleanupPreview.snapshot.plan.mutations[0].remove, ['status: in progress', 'bug']);
  assert.equal(mutationCalls().length, mutationsBeforeCleanupPreview);
  const cursors = fixture.state.calls.filter(call => call.url === 'https://api.github.com/graphql').slice(-2).map(call => call.body.variables.cursor);
  assert.deepEqual(cursors, [null, 'cursor-2']);

  const firstCleanup = await main([
    'cleanup', '--apply', '--reviewed-snapshot', cleanupPreviewPath, '--plan-id', cleanupPreview.snapshot.planId,
    '--snapshot', tempSnapshot(directory, 'cleanup-first-apply.json'),
  ], dependencies);
  assert.equal(firstCleanup.exitCode, 1);
  assert.match(firstCleanup.snapshot.execution.failed[0].error, /injected failure/);
  const cleanupMutations = mutationCalls().slice(mutationsBeforeCleanupPreview);
  assert.deepEqual(cleanupMutations[0], {
    method: 'POST', url: 'https://api.github.com/repos/ebarti/jobctrl/issues/41/labels', body: { labels: ['type: bug'] },
  });
  assert.equal(cleanupMutations[1].url, 'https://api.github.com/repos/ebarti/jobctrl/issues/41/labels/status%3A%20in%20progress');
  assert.equal(cleanupMutations[1].method, 'DELETE');
  assert.equal(cleanupMutations[2].url, 'https://api.github.com/repos/ebarti/jobctrl/issues/41/labels/bug');
  assert.equal(cleanupMutations[2].method, 'DELETE');

  const rerunPreviewPath = tempSnapshot(directory, 'cleanup-rerun-preview.json');
  const rerunPreview = await main(['cleanup', '--snapshot', rerunPreviewPath], dependencies);
  assert.deepEqual(rerunPreview.snapshot.plan.mutations[0].add, []);
  assert.deepEqual(rerunPreview.snapshot.plan.mutations[0].remove, ['bug']);
  const rerun = await main([
    'cleanup', '--apply', '--reviewed-snapshot', rerunPreviewPath, '--plan-id', rerunPreview.snapshot.planId,
    '--snapshot', tempSnapshot(directory, 'cleanup-rerun-apply.json'),
  ], dependencies);
  assert.equal(rerun.exitCode, 0);
  assert.deepEqual(fixture.state.issues[0].labels.map(label => label.name).sort(), ['custom: keep', 'type: bug']);
  assert.deepEqual(fixture.state.issues[0].assignees, [{ login: 'maintainer' }]);
  const converged = await main(['cleanup', '--snapshot', tempSnapshot(directory, 'cleanup-converged.json')], dependencies);
  assert.deepEqual(converged.snapshot.plan.mutations, []);
  assert.equal(converged.snapshot.execution.attemptedWrites, 0);
});
