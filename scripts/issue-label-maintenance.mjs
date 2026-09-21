#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { LABEL_CATALOGUE, LEGACY_TYPE_ALIASES } from './issue-label-catalogue.mjs';

const PAGE_SIZE = 100;
const RETIRED_DEFINITIONS = new Set([
  'bug', 'documentation', 'enhancement', 'question',
  'status: backlog', 'status: done', 'status: in progress',
  'status: in review', 'status: needs triage',
]);

function labelName(label) {
  return typeof label === 'string' ? label : label.name;
}

function itemSnapshot(item, projectMemberships = []) {
  return {
    number: item.number,
    kind: item.pull_request ? 'pull_request' : 'issue',
    state: item.state,
    title: item.title,
    url: item.html_url,
    labels: (item.labels ?? []).map(labelName).sort(),
    assignees: (item.assignees ?? []).map(assignee => assignee.login).sort(),
    projectMemberships: projectMemberships
      .map(membership => ({ id: membership.id, statuses: [...membership.statuses].sort() }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function mutationFor(map, item) {
  if (!map.has(item.number)) {
    map.set(item.number, {
      number: item.number,
      kind: item.pull_request ? 'pull_request' : 'issue',
      add: [],
      remove: [],
      reasons: [],
    });
  }
  return map.get(item.number);
}

function addUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}

export async function paginateRest(loadPage) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const values = await loadPage(page, PAGE_SIZE);
    all.push(...values);
    if (values.length < PAGE_SIZE) return all;
  }
}

export async function paginateCursor(loadPage) {
  const all = [];
  let cursor = null;
  for (;;) {
    const page = await loadPage(cursor, PAGE_SIZE);
    all.push(...page.nodes);
    if (!page.hasNextPage) return all;
    if (!page.nextCursor || page.nextCursor === cursor) throw new Error('Project pagination did not advance.');
    cursor = page.nextCursor;
  }
}

export function buildCataloguePlan(remoteLabels) {
  const remote = new Map(remoteLabels.map(label => [label.name, label]));
  const create = [];
  const update = [];
  for (const [name, definition] of Object.entries(LABEL_CATALOGUE)) {
    const existing = remote.get(name);
    if (!existing) {
      create.push({ name, ...definition });
      continue;
    }
    const currentColor = (existing.color ?? '').toLowerCase();
    const currentDescription = existing.description ?? '';
    if (currentColor !== definition.color || currentDescription !== definition.description) {
      update.push({
        name,
        before: { color: currentColor, description: currentDescription },
        after: { ...definition },
      });
    }
  }
  const retired = remoteLabels
    .filter(label => RETIRED_DEFINITIONS.has(label.name))
    .map(label => label.name)
    .sort();
  return { create, update, retired };
}

async function writeSnapshot(snapshotPath, snapshot) {
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  const temporaryPath = `${snapshotPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'w' });
  await rename(temporaryPath, snapshotPath);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function reviewId(review) {
  return createHash('sha256').update(canonicalJson(review)).digest('hex');
}

function catalogueReview(before, plan) {
  const remote = new Map(before.map(label => [label.name, label]));
  return {
    mode: 'catalogue',
    labels: Object.keys(LABEL_CATALOGUE).sort().map(name => {
      const label = remote.get(name);
      return label
        ? { name, present: true, color: (label.color ?? '').toLowerCase(), description: label.description ?? '' }
        : { name, present: false };
    }),
    plan,
  };
}

function validateReviewedPlan({ reviewedSnapshot, reviewedPlanId, mode, currentReview }) {
  if (!reviewedSnapshot || !reviewedPlanId) {
    throw new Error('--apply requires an immutable --reviewed-snapshot and its --plan-id.');
  }
  if (reviewedSnapshot.schemaVersion !== 2 || reviewedSnapshot.mode !== mode || reviewedSnapshot.apply !== false) {
    throw new Error(`Reviewed snapshot is not a schema 2 ${mode} dry-run.`);
  }
  const embeddedId = reviewId(reviewedSnapshot.review);
  if (embeddedId !== reviewedSnapshot.planId || embeddedId !== reviewedPlanId) {
    throw new Error('Reviewed snapshot identity does not match --plan-id.');
  }
  if (canonicalJson(reviewedSnapshot.plan) !== canonicalJson(reviewedSnapshot.review.plan)) {
    throw new Error('Reviewed snapshot plan does not match its immutable review payload.');
  }
  const currentId = reviewId(currentReview);
  if (currentId !== reviewedPlanId) {
    throw new Error(`Reviewed plan drifted before apply (expected ${reviewedPlanId}, observed ${currentId}).`);
  }
}

function emptyExecution() {
  return { attemptedWrites: 0, succeeded: [], failed: [], skipped: [], journal: [] };
}

async function journalAttempt({ snapshot, snapshotPath, operation, execute, now }) {
  const entry = { ...operation, status: 'attempting', startedAt: now().toISOString() };
  snapshot.execution.attemptedWrites += 1;
  snapshot.execution.journal.push(entry);
  await writeSnapshot(snapshotPath, snapshot);
  try {
    const result = await execute();
    entry.status = result?.raced ? 'raced' : 'succeeded';
    entry.completedAt = now().toISOString();
    snapshot.execution.succeeded.push({ ...operation, ...(result?.raced ? { raced: true } : {}) });
    await writeSnapshot(snapshotPath, snapshot);
    return true;
  } catch (error) {
    entry.status = 'failed';
    entry.completedAt = now().toISOString();
    entry.error = error.message;
    snapshot.execution.failed.push({ ...operation, error: error.message });
    await writeSnapshot(snapshotPath, snapshot);
    return false;
  }
}

export async function runCatalogueSync({
  adapter,
  apply = false,
  snapshotPath,
  reviewedSnapshot,
  reviewedPlanId,
  now = () => new Date(),
}) {
  const before = await paginateRest((page, perPage) => adapter.listLabelsPage(page, perPage));
  const currentPlan = buildCataloguePlan(before);
  const currentReview = catalogueReview(before, currentPlan);

  if (!apply) {
    const snapshot = {
      schemaVersion: 2,
      mode: 'catalogue',
      apply: false,
      generatedAt: now().toISOString(),
      planId: reviewId(currentReview),
      review: currentReview,
      before,
      plan: currentPlan,
      execution: emptyExecution(),
      after: before,
    };
    await writeSnapshot(snapshotPath, snapshot);
    return snapshot;
  }

  validateReviewedPlan({ reviewedSnapshot, reviewedPlanId, mode: 'catalogue', currentReview });
  const plan = reviewedSnapshot.plan;
  const snapshot = {
    schemaVersion: 2,
    mode: 'catalogue',
    apply: true,
    phase: 'preflight',
    generatedAt: now().toISOString(),
    planId: reviewedPlanId,
    before,
    plan,
    execution: emptyExecution(),
    after: null,
  };
  await writeSnapshot(snapshotPath, snapshot);

  snapshot.phase = 'applying';
  await writeSnapshot(snapshotPath, snapshot);
  for (const operation of plan.create) {
    await journalAttempt({
      snapshot,
      snapshotPath,
      operation: { action: 'create', name: operation.name },
      execute: () => adapter.createLabel(operation),
      now,
    });
  }
  for (const operation of plan.update) {
    await journalAttempt({
      snapshot,
      snapshotPath,
      operation: { action: 'update', name: operation.name },
      execute: () => adapter.updateLabel(operation.name, operation.after),
      now,
    });
  }

  try {
    snapshot.after = await paginateRest((page, perPage) => adapter.listLabelsPage(page, perPage));
    snapshot.phase = 'complete';
    const remaining = buildCataloguePlan(snapshot.after);
    if (remaining.create.length > 0 || remaining.update.length > 0) {
      snapshot.execution.failed.push({ action: 'verify', error: 'Catalogue did not converge after apply.', remaining });
    }
  } catch (error) {
    snapshot.phase = 'after-read-failed';
    snapshot.afterReadError = error.message;
    snapshot.execution.failed.push({ action: 'refresh', error: error.message });
  }
  await writeSnapshot(snapshotPath, snapshot);
  return snapshot;
}

function projectMembershipsByNumber(projectItems, repository) {
  const result = new Map();
  for (const item of projectItems) {
    if (!item.content || item.content.repository.toLowerCase() !== repository.toLowerCase()) continue;
    const memberships = result.get(item.content.number) ?? [];
    memberships.push({ id: item.id, statuses: item.statuses ?? [] });
    result.set(item.content.number, memberships);
  }
  return result;
}

function verifiedProjectStatus(item, memberships, expectedStatus) {
  if (memberships.length === 0) return { ok: false, reason: 'project-membership-missing' };
  if (memberships.length !== 1) return { ok: false, reason: 'project-membership-ambiguous' };
  if (memberships[0].statuses.length !== 1) return { ok: false, reason: 'project-status-missing-or-ambiguous' };
  const status = memberships[0].statuses[0];
  if (expectedStatus && status !== expectedStatus) {
    return { ok: false, reason: 'project-status-unexpected', observed: status, expected: expectedStatus };
  }
  return { ok: true, status };
}

export function buildCleanupPlan({ items, projectItems, repository, reviewedCorrections = [] }) {
  const memberships = projectMembershipsByNumber(projectItems, repository);
  const mutations = new Map();
  const skips = [];

  for (const item of items.filter(candidate => candidate.state === 'open')) {
    const labels = new Set((item.labels ?? []).map(labelName));
    const statusLabels = [...labels].filter(label =>
      label.startsWith('status: ') && label !== 'status: needs validation');
    if (statusLabels.length > 0) {
      const verified = verifiedProjectStatus(item, memberships.get(item.number) ?? []);
      if (verified.ok) {
        const mutation = mutationFor(mutations, item);
        for (const label of statusLabels) addUnique(mutation.remove, label);
        mutation.reasons.push(`Project 7 Status is ${verified.status}; progress labels are retired.`);
      } else {
        skips.push({ number: item.number, labels: statusLabels.sort(), ...verified });
      }
    }

    const aliases = [...labels].filter(label => Object.hasOwn(LEGACY_TYPE_ALIASES, label));
    const aliasTargets = [...new Set(aliases.map(label => LEGACY_TYPE_ALIASES[label]))];
    if (aliasTargets.length > 1) {
      skips.push({ number: item.number, labels: aliases.sort(), reason: 'legacy-type-aliases-conflict' });
    } else if (aliasTargets.length === 1) {
      const target = aliasTargets[0];
      const currentTypes = [...labels].filter(label => label.startsWith('type: '));
      const conflicts = currentTypes.filter(label => label !== target);
      if (conflicts.length > 0) {
        skips.push({ number: item.number, labels: [...aliases, ...currentTypes].sort(), reason: 'legacy-type-conflicts-with-manual-type' });
      } else {
        const mutation = mutationFor(mutations, item);
        if (!labels.has(target)) addUnique(mutation.add, target);
        for (const alias of aliases) addUnique(mutation.remove, alias);
        mutation.reasons.push(`Canonicalize legacy type alias to ${target}.`);
      }
    }
  }

  for (const correction of reviewedCorrections) {
    const item = items.find(candidate => candidate.number === correction.number);
    if (!item) {
      skips.push({ number: correction.number, label: correction.label, reason: 'reviewed-item-missing' });
      continue;
    }
    if (correction.expectedState && item.state !== correction.expectedState) {
      skips.push({ number: item.number, label: correction.label, reason: 'reviewed-state-unexpected', observed: item.state, expected: correction.expectedState });
      continue;
    }
    if (correction.label.startsWith('status: ') && !correction.expectedProjectStatus) {
      skips.push({ number: item.number, label: correction.label, reason: 'reviewed-status-removal-requires-project-status' });
      continue;
    }
    if (correction.expectedProjectStatus) {
      const verified = verifiedProjectStatus(item, memberships.get(item.number) ?? [], correction.expectedProjectStatus);
      if (!verified.ok) {
        skips.push({ number: item.number, label: correction.label, ...verified });
        continue;
      }
    }
    const labels = new Set((item.labels ?? []).map(labelName));
    if (!labels.has(correction.label)) continue;
    const mutation = mutationFor(mutations, item);
    addUnique(mutation.remove, correction.label);
    mutation.reasons.push(`Reviewed correction: ${correction.reason}`);
  }

  return {
    mutations: [...mutations.values()].sort((left, right) => left.number - right.number),
    skips: skips.sort((left, right) => left.number - right.number),
  };
}

async function readCleanupState({ adapter, repository, projectNumber, reviewedCorrections }) {
  const openItems = await paginateRest((page, perPage) => adapter.listOpenItemsPage(page, perPage));
  const byNumber = new Map(openItems.map(item => [item.number, item]));
  for (const number of new Set(reviewedCorrections.map(correction => correction.number))) {
    if (!byNumber.has(number)) byNumber.set(number, await adapter.getItem(number));
  }
  const projectItems = await paginateCursor((cursor, first) => adapter.listProjectItemsPage(projectNumber, cursor, first));
  const memberships = projectMembershipsByNumber(projectItems, repository);
  const items = [...byNumber.values()].sort((left, right) => left.number - right.number);
  return {
    items,
    projectItems,
    snapshot: items.map(item => itemSnapshot(item, memberships.get(item.number) ?? [])),
  };
}

function cleanupReview({ before, repository, projectNumber, reviewedCorrections, plan }) {
  const correctionLabels = new Map();
  for (const correction of reviewedCorrections) {
    const labels = correctionLabels.get(correction.number) ?? new Set();
    labels.add(correction.label);
    correctionLabels.set(correction.number, labels);
  }
  const items = before.snapshot.flatMap(item => {
    const correctionSet = correctionLabels.get(item.number) ?? new Set();
    const hasAutomaticCandidate = item.labels.some(label => label.startsWith('status: ') || Object.hasOwn(LEGACY_TYPE_ALIASES, label));
    if (!hasAutomaticCandidate && correctionSet.size === 0) return [];
    const labels = item.labels.filter(label =>
      label.startsWith('status: ')
      || label.startsWith('type: ')
      || Object.hasOwn(LEGACY_TYPE_ALIASES, label)
      || correctionSet.has(label));
    const needsProjectState = item.labels.some(label => label.startsWith('status: '))
      || reviewedCorrections.some(correction => correction.number === item.number && correction.expectedProjectStatus);
    return [{
      number: item.number,
      kind: item.kind,
      state: item.state,
      labels,
      projectMemberships: needsProjectState ? item.projectMemberships : [],
    }];
  });
  return {
    mode: 'cleanup',
    repository: repository.toLowerCase(),
    projectNumber,
    reviewedCorrections,
    items,
    plan,
  };
}

export async function runCleanup({
  adapter,
  repository,
  projectNumber = 7,
  reviewedCorrections = [],
  apply = false,
  snapshotPath,
  reviewedSnapshot,
  reviewedPlanId,
  now = () => new Date(),
}) {
  const before = await readCleanupState({ adapter, repository, projectNumber, reviewedCorrections });
  const currentPlan = buildCleanupPlan({
    items: before.items,
    projectItems: before.projectItems,
    repository,
    reviewedCorrections,
  });
  const currentReview = cleanupReview({ before, repository, projectNumber, reviewedCorrections, plan: currentPlan });

  if (!apply) {
    const snapshot = {
      schemaVersion: 2,
      mode: 'cleanup',
      apply: false,
      repository,
      projectNumber,
      generatedAt: now().toISOString(),
      reviewedCorrections,
      planId: reviewId(currentReview),
      review: currentReview,
      before: before.snapshot,
      plan: currentPlan,
      execution: emptyExecution(),
      after: before.snapshot,
    };
    await writeSnapshot(snapshotPath, snapshot);
    return snapshot;
  }

  validateReviewedPlan({ reviewedSnapshot, reviewedPlanId, mode: 'cleanup', currentReview });
  const plan = reviewedSnapshot.plan;
  const snapshot = {
    schemaVersion: 2,
    mode: 'cleanup',
    apply: true,
    phase: 'preflight',
    repository,
    projectNumber,
    generatedAt: now().toISOString(),
    reviewedCorrections,
    planId: reviewedPlanId,
    before: before.snapshot,
    plan,
    execution: emptyExecution(),
    after: null,
  };
  await writeSnapshot(snapshotPath, snapshot);

  snapshot.phase = 'applying';
  await writeSnapshot(snapshotPath, snapshot);
  for (const mutation of plan.mutations) {
    let additionFailed = false;
    if (mutation.add.length > 0) {
      additionFailed = !(await journalAttempt({
        snapshot,
        snapshotPath,
        operation: { number: mutation.number, action: 'add', labels: mutation.add },
        execute: () => adapter.addLabels(mutation.number, mutation.add),
        now,
      }));
    }
    if (additionFailed) {
      for (const label of mutation.remove) {
        snapshot.execution.skipped.push({ number: mutation.number, action: 'remove', label, reason: 'required-label-addition-failed' });
      }
      await writeSnapshot(snapshotPath, snapshot);
      continue;
    }
    for (const label of mutation.remove) {
      await journalAttempt({
        snapshot,
        snapshotPath,
        operation: { number: mutation.number, action: 'remove', label },
        execute: () => adapter.removeLabel(mutation.number, label),
        now,
      });
    }
  }

  try {
    const after = await readCleanupState({ adapter, repository, projectNumber, reviewedCorrections });
    snapshot.after = after.snapshot;
    snapshot.phase = 'complete';
  } catch (error) {
    snapshot.phase = 'after-read-failed';
    snapshot.afterReadError = error.message;
    snapshot.execution.failed.push({ action: 'refresh', error: error.message });
  }
  await writeSnapshot(snapshotPath, snapshot);
  return snapshot;
}

function createHttpClient(token, fetchImpl) {
  return async function request(url, options = {}) {
    const response = await fetchImpl(url, {
      ...options,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        ...options.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`GitHub API ${response.status}: ${body}`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  };
}

export function createGitHubAdapter({ owner, repo, token, fetchImpl = fetch }) {
  if (!token) throw new Error('Set GH_TOKEN or GITHUB_TOKEN for GitHub API access.');
  const request = createHttpClient(token, fetchImpl);
  const api = 'https://api.github.com';
  const repository = `${owner}/${repo}`;
  const rest = suffix => `${api}/repos/${owner}/${repo}${suffix}`;

  async function graphql(query, variables) {
    const result = await request(`${api}/graphql`, {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
    });
    if (result.errors?.length) throw new Error(`GitHub GraphQL: ${result.errors.map(error => error.message).join('; ')}`);
    return result.data;
  }

  return {
    repository,
    listLabelsPage: (page, perPage) => request(rest(`/labels?per_page=${perPage}&page=${page}`)),
    async createLabel(definition) {
      try {
        return await request(rest('/labels'), { method: 'POST', body: JSON.stringify(definition) });
      } catch (error) {
        if (error.status === 409 || error.status === 422) return { raced: true };
        throw error;
      }
    },
    updateLabel: (name, definition) => request(rest(`/labels/${encodeURIComponent(name)}`), { method: 'PATCH', body: JSON.stringify(definition) }),
    listOpenItemsPage: (page, perPage) => request(rest(`/issues?state=open&sort=created&direction=asc&per_page=${perPage}&page=${page}`)),
    getItem: number => request(rest(`/issues/${number}`)),
    addLabels: (number, labels) => request(rest(`/issues/${number}/labels`), { method: 'POST', body: JSON.stringify({ labels }) }),
    removeLabel: (number, label) => request(rest(`/issues/${number}/labels/${encodeURIComponent(label)}`), { method: 'DELETE' }),
    async listProjectItemsPage(projectNumber, cursor, first) {
      const query = `query($owner: String!, $repo: String!, $projectNumber: Int!, $first: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          owner {
            ... on User { projectV2(number: $projectNumber) { items(first: $first, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id content { ... on Issue { number state repository { nameWithOwner } } ... on PullRequest { number state repository { nameWithOwner } } } fieldValues(first: 50) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } } } } } } }
            ... on Organization { projectV2(number: $projectNumber) { items(first: $first, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id content { ... on Issue { number state repository { nameWithOwner } } ... on PullRequest { number state repository { nameWithOwner } } } fieldValues(first: 50) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } } } } } } }
          }
        }
      }`;
      const data = await graphql(query, { owner, repo, projectNumber, first, cursor });
      const project = data.repository?.owner?.projectV2;
      if (!project) throw new Error(`Project ${projectNumber} was not found for ${repository}.`);
      return {
        nodes: project.items.nodes.map(item => ({
          id: item.id,
          content: item.content ? {
            number: item.content.number,
            state: item.content.state.toLowerCase(),
            repository: item.content.repository.nameWithOwner,
          } : null,
          statuses: item.fieldValues.nodes
            .filter(value => value?.field?.name === 'Status' && value.name)
            .map(value => value.name),
        })),
        hasNextPage: project.items.pageInfo.hasNextPage,
        nextCursor: project.items.pageInfo.endCursor,
      };
    },
  };
}

function parseArguments(argv) {
  const [mode, ...args] = argv;
  if (!['catalogue', 'cleanup'].includes(mode)) throw new Error('usage: issue-label-maintenance.mjs catalogue|cleanup [--apply] [options]');
  const options = {
    mode,
    apply: false,
    owner: 'ebarti',
    repo: 'jobctrl',
    projectNumber: 7,
    reviewedCorrections: [],
    expectedStates: new Map(),
    expectedProjectStatuses: new Map(),
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--owner') options.owner = args[++index];
    else if (argument === '--repo') options.repo = args[++index];
    else if (argument === '--project-number') options.projectNumber = Number(args[++index]);
    else if (argument === '--snapshot') options.snapshotPath = path.resolve(args[++index]);
    else if (argument === '--reviewed-snapshot') options.reviewedSnapshotPath = path.resolve(args[++index]);
    else if (argument === '--plan-id') options.reviewedPlanId = args[++index];
    else if (argument === '--expect-state') options.expectedStates.set(Number(args[++index]), args[++index]);
    else if (argument === '--expect-project-status') options.expectedProjectStatuses.set(Number(args[++index]), args[++index]);
    else if (argument === '--reviewed-remove') {
      options.reviewedCorrections.push({ number: Number(args[++index]), label: args[++index], reason: args[++index] });
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.snapshotPath) {
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    options.snapshotPath = path.resolve(`issue-label-${mode}-${timestamp}.json`);
  }
  if (options.apply && (!options.reviewedSnapshotPath || !options.reviewedPlanId)) {
    throw new Error('--apply requires --reviewed-snapshot and --plan-id.');
  }
  if (options.apply && options.reviewedSnapshotPath === options.snapshotPath) {
    throw new Error('Apply output --snapshot must differ from the immutable --reviewed-snapshot.');
  }
  if (!options.apply && (options.reviewedSnapshotPath || options.reviewedPlanId)) {
    throw new Error('--reviewed-snapshot and --plan-id are valid only with --apply.');
  }
  options.reviewedCorrections = options.reviewedCorrections.map(correction => ({
    ...correction,
    expectedState: options.expectedStates.get(correction.number),
    expectedProjectStatus: options.expectedProjectStatuses.get(correction.number),
  }));
  for (const correction of options.reviewedCorrections) {
    if (!Number.isInteger(correction.number) || correction.number <= 0 || !correction.label || !correction.reason) {
      throw new Error('--reviewed-remove requires a positive issue number, label, and reason.');
    }
    if (!correction.expectedState) {
      throw new Error(`--reviewed-remove for #${correction.number} requires --expect-state.`);
    }
  }
  return options;
}

function summary(snapshot, snapshotPath) {
  if (snapshot.mode === 'catalogue') {
    return {
      mode: snapshot.mode,
      apply: snapshot.apply,
      snapshot: snapshotPath,
      planId: snapshot.planId,
      phase: snapshot.phase,
      create: snapshot.plan.create.length,
      update: snapshot.plan.update.length,
      retired: snapshot.plan.retired,
      writes: snapshot.execution.attemptedWrites,
      failures: snapshot.execution.failed,
    };
  }
  return {
    mode: snapshot.mode,
    apply: snapshot.apply,
    snapshot: snapshotPath,
    planId: snapshot.planId,
    phase: snapshot.phase,
    items: snapshot.before.length,
    mutations: snapshot.plan.mutations,
    skips: snapshot.plan.skips,
    additions: snapshot.plan.mutations.reduce((total, mutation) => total + mutation.add.length, 0),
    removals: snapshot.plan.mutations.reduce((total, mutation) => total + mutation.remove.length, 0),
    writes: snapshot.execution.attemptedWrites,
    failures: snapshot.execution.failed,
  };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(argv);
  const environment = dependencies.env ?? process.env;
  const output = dependencies.stdout ?? process.stdout;
  const reviewedSnapshot = options.reviewedSnapshotPath
    ? JSON.parse(await readFile(options.reviewedSnapshotPath, 'utf8'))
    : undefined;
  const adapter = createGitHubAdapter({
    owner: options.owner,
    repo: options.repo,
    token: environment.GH_TOKEN ?? environment.GITHUB_TOKEN,
    fetchImpl: dependencies.fetchImpl ?? fetch,
  });
  const snapshot = options.mode === 'catalogue'
    ? await runCatalogueSync({
      adapter,
      apply: options.apply,
      snapshotPath: options.snapshotPath,
      reviewedSnapshot,
      reviewedPlanId: options.reviewedPlanId,
      now: dependencies.now,
    })
    : await runCleanup({
      adapter,
      repository: adapter.repository,
      projectNumber: options.projectNumber,
      reviewedCorrections: reviewedSnapshot?.reviewedCorrections ?? options.reviewedCorrections,
      apply: options.apply,
      snapshotPath: options.snapshotPath,
      reviewedSnapshot,
      reviewedPlanId: options.reviewedPlanId,
      now: dependencies.now,
    });
  output.write(`${JSON.stringify(summary(snapshot, options.snapshotPath), null, 2)}\n`);
  return { snapshot, exitCode: snapshot.execution.failed.length > 0 ? 1 : 0 };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (fileURLToPath(import.meta.url) === invokedPath) {
  main()
    .then(result => { process.exitCode = result.exitCode; })
    .catch(error => {
      process.stderr.write(`${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    });
}
