import { labelDefinition } from './issue-label-catalogue.mjs';

const AREAS = new Map([
  ['Web app', 'web'], ['Dashboard or Jobs', 'web'], ['Apply Review', 'web'],
  ['Artifacts', 'web'], ['Profile or Settings', 'web'],
  ['TypeScript API', 'api'], ['Python worker or CLI', 'cli-worker'],
  ['CLI or worker', 'cli-worker'], ['Browser extension', 'browser-extension'],
  ['Documentation', 'docs'], ['Documentation site', 'docs'],
  ['Setup or install', 'setup'], ['GitHub workflows', 'github'],
  ['GitHub workflow', 'github'], ['Contributor workflow', 'github'],
]);

const BRACKETED_TYPES = new Map([
  ['bug', 'bug'], ['feature', 'feature'], ['qa', 'qa-regression'],
  ['docs', 'documentation'], ['question', 'question'],
  ['security contact', 'security-contact'],
]);

const CONVENTIONAL_TYPES = new Map([
  ['fix', 'bug'], ['feat', 'feature'], ['docs', 'documentation'],
  ['test', 'test'], ['chore', 'maintenance'], ['build', 'maintenance'],
  ['ci', 'maintenance'], ['refactor', 'maintenance'], ['perf', 'maintenance'],
  ['design', 'investigation'], ['investigate', 'investigation'],
]);

const AREA_FIELDS = ['Affected area', 'Area', 'Regression surface'];
const RELEASE_FIELD = 'Release impact';
const RELEASE_CHECKBOX = 'This appears to block a public release, source install, or documented first-run flow.';
const issueTriageQueues = new Map();

function labelNames(issue) {
  return new Set((issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name));
}

function issueFields(body = '') {
  const result = new Map();
  for (const match of body.replaceAll('\r\n', '\n').matchAll(/^### ([^\n]+)\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)) {
    const key = match[1].trim();
    result.set(key, result.has(key) ? null : match[2].trim());
  }
  return result;
}

function declaredType(title) {
  const bracketed = title.match(/^\[(bug|feature|qa|docs|question|security contact)\]:\s*/i);
  if (bracketed) return BRACKETED_TYPES.get(bracketed[1].toLowerCase());

  const conventional = title.match(/^(fix|feat|docs|test|chore|build|ci|refactor|perf|design|investigate)(?:\([a-z0-9._/-]+\))?!?:\s+\S/i);
  return conventional ? CONVENTIONAL_TYPES.get(conventional[1].toLowerCase()) : undefined;
}

function checkedReleaseImpact(form) {
  const value = form.get(RELEASE_FIELD);
  if (!value) return false;
  return value.split('\n').some(line => {
    const match = line.match(/^- \[([xX])\] (.+)$/);
    return match?.[2] === RELEASE_CHECKBOX;
  });
}

export function labelsForIssue(issue) {
  if (issue.state && issue.state !== 'open') return [];

  const current = labelNames(issue);
  const additions = [];
  const form = issueFields(issue.body ?? '');
  const hasType = [...current].some(label => label.startsWith('type: '));
  const inferredType = hasType ? undefined : declaredType(issue.title ?? '');
  if (inferredType) additions.push(`type: ${inferredType}`);

  const securityContact = current.has('type: security-contact') || inferredType === 'security-contact';
  const hasArea = [...current].some(label => label.startsWith('area: '));
  if (!hasArea) {
    const selected = AREA_FIELDS.filter(key => form.has(key));
    if (selected.length === 1) {
      const area = AREAS.get(form.get(selected[0]));
      if (area) additions.push(`area: ${area}`);
    } else if (selected.length === 0 && securityContact) {
      additions.push('area: security');
    }
  }

  if (securityContact && !current.has('privacy: review-needed')) {
    additions.push('privacy: review-needed');
  }
  if (!current.has('release: possible-blocker') && checkedReleaseImpact(form)) {
    additions.push('release: possible-blocker');
  }

  return additions.filter((label, index) => !current.has(label) && additions.indexOf(label) === index);
}

export async function ensureDeclaredLabel({ github, owner, repo, name }) {
  const definition = labelDefinition(name);
  if (!definition) throw new Error(`Refusing to create undeclared label: ${name}`);

  try {
    await github.rest.issues.getLabel({ owner, repo, name });
    return { name, created: false };
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  try {
    await github.rest.issues.createLabel({ owner, repo, name, ...definition });
    return { name, created: true };
  } catch (error) {
    if (error.status === 409 || error.status === 422) return { name, created: false, raced: true };
    throw error;
  }
}

async function getIssue(github, owner, repo, issueNumber) {
  const { data } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
  return data;
}

async function triageLatestIssue({ github, owner, repo, issueNumber }) {
  let issue = await getIssue(github, owner, repo, issueNumber);
  let additions = labelsForIssue(issue);
  if (additions.length === 0) return { additions: [], ensured: [] };

  const ensured = [];
  const ensuredNames = new Set();
  for (;;) {
    for (const name of additions) {
      if (ensuredNames.has(name)) continue;
      ensured.push(await ensureDeclaredLabel({ github, owner, repo, name }));
      ensuredNames.add(name);
    }

    issue = await getIssue(github, owner, repo, issueNumber);
    const latestAdditions = labelsForIssue(issue);
    if (latestAdditions.length === 0) return { additions: [], ensured };
    if (latestAdditions.every(name => ensuredNames.has(name))) {
      additions = latestAdditions;
      break;
    }
    additions = latestAdditions;
  }

  await github.rest.issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels: additions,
  });
  return { additions, ensured };
}

export async function triageIssue({ github, owner, repo, issueNumber }) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('A positive issue number is required.');
  const key = `${owner}/${repo}#${issueNumber}`.toLowerCase();
  const previous = issueTriageQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => triageLatestIssue({ github, owner, repo, issueNumber }));
  issueTriageQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (issueTriageQueues.get(key) === current) issueTriageQueues.delete(key);
  }
}
