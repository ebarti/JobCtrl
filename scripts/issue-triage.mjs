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
const PRIVACY_IGNORED_FIELDS = /^(?:data-safety confirmation|public issue confirmation|confirmation|release impact)$/i;
const SENSITIVE_OBJECT_SOURCE = String.raw`(?:secrets?|api[ -]?keys?|tokens?|credentials?|passwords?|private[ -]?data|personal[ -]?data|profile[ -]?facts?|resumes?|generated[ -]?materials?|browser[ -]?profiles?|sqlite[ -]?databases?|exploit[ -]?details?)`;
const EXPOSURE_ACTION_SOURCE = String.raw`(?:expos(?:e|es|ed)|leak(?:s|ed)?|visibl(?:e|ity)|logged|printed|shown|disclos(?:e|es|ed)|published|committed|pasted|rendered)`;
const EXPOSURE_SURFACE_SOURCE = String.raw`(?:logs?|output|responses?|errors?|console|terminal|ui|pages?|screens?|issues?|commits?)`;
const NEGATION_SOURCE = String.raw`(?:not|never|doesn['’]t|don['’]t|didn['’]t|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|hasn['’]t|haven['’]t|hadn['’]t|won['’]t|wouldn['’]t|can['’]t|couldn['’]t|shouldn['’]t)`;
const NEGATION_MODIFIER_SOURCE = String.raw`(?:[a-z]+ly|ever|yet|still)`;
const ACTION_NEGATION_PATTERN = new RegExp(String.raw`\b${NEGATION_SOURCE}(?:\s+${NEGATION_MODIFIER_SOURCE}){0,3}\s*$`, 'i');
const OBJECT_NEGATION_PATTERN = /\b(?:no|without)\s*$/i;
const SURFACE_NEGATION_PATTERN = new RegExp(
  String.raw`\b${NEGATION_SOURCE}(?:\s+${NEGATION_MODIFIER_SOURCE}){0,3}(?:\s+(?:appears?|appeared|show(?:s|ed)? up|be))?\s+(?:in|into|on|via)\b`,
  'i',
);
const ASSERTION_BOUNDARY_PATTERN = /\n+|;+|(?<=[.!?])\s+|\s+(?:although|though|but|however|while|whereas)\s+/i;
const issueTriageQueues = new Map();

function labelNames(issue) {
  return new Set((issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name));
}

export function issueFields(body = '') {
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

function privacyText(issue, form) {
  const values = [];
  if (issue.title) values.push(issue.title);
  if (form.size > 0) {
    for (const [key, value] of form) {
      if (value && !PRIVACY_IGNORED_FIELDS.test(key)) values.push(value);
    }
  } else if (issue.body) {
    values.push(issue.body
      .split('\n')
      .filter(line => !/\b(?:i have not included|do not include)\b/i.test(line))
      .join('\n'));
  }
  return values.join('\n');
}

function findPhrases(text, source) {
  return [...text.matchAll(new RegExp(String.raw`\b${source}\b`, 'gi'))]
    .map(match => ({ index: match.index, end: match.index + match[0].length }));
}

function nearestPhrase(phrase, candidates) {
  let nearest;
  for (const candidate of candidates) {
    const distance = candidate.end <= phrase.index
      ? phrase.index - candidate.end
      : phrase.end <= candidate.index
        ? candidate.index - phrase.end
        : 0;
    if (distance > 60) continue;
    if (!nearest || distance < nearest.distance) nearest = { ...candidate, distance };
  }
  return nearest;
}

function objectIsNegated(assertion, object) {
  return OBJECT_NEGATION_PATTERN.test(assertion.slice(Math.max(0, object.index - 16), object.index));
}

function actionIsNegated(assertion, action) {
  return ACTION_NEGATION_PATTERN.test(assertion.slice(0, action.index));
}

function assertionHasExposure(assertion) {
  const objects = findPhrases(assertion, SENSITIVE_OBJECT_SOURCE);
  if (objects.length === 0) return false;

  const actions = findPhrases(assertion, EXPOSURE_ACTION_SOURCE);
  for (const action of actions) {
    const object = nearestPhrase(action, objects);
    if (object && !objectIsNegated(assertion, object) && !actionIsNegated(assertion, action)) return true;
  }

  const surfacePattern = new RegExp(
    String.raw`\b${SENSITIVE_OBJECT_SOURCE}\b.{0,40}?\b(?:appears?|appeared|shows? up|is|was|were)?\s*(?:in|into|on|via)\s+(?:the\s+)?${EXPOSURE_SURFACE_SOURCE}\b`,
    'gi',
  );
  for (const match of assertion.matchAll(surfacePattern)) {
    const object = objects.find(candidate => candidate.index === match.index);
    if (!object) continue;
    const hasSurfacePredicate = /\b(?:appears?|appeared|shows? up)\b/i.test(match[0]);
    if (!hasSurfacePredicate && nearestPhrase(object, actions)) continue;
    if (!objectIsNegated(assertion, object) && !SURFACE_NEGATION_PATTERN.test(match[0])) return true;
  }
  return false;
}

function isExplicitExposure(issue, form) {
  return privacyText(issue, form)
    .split(ASSERTION_BOUNDARY_PATTERN)
    .some(assertionHasExposure);
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

  const hasArea = [...current].some(label => label.startsWith('area: '));
  if (!hasArea) {
    const selected = AREA_FIELDS.filter(key => form.has(key));
    if (selected.length === 1) {
      const area = AREAS.get(form.get(selected[0]));
      if (area) additions.push(`area: ${area}`);
    } else if (selected.length === 0 && inferredType === 'documentation') {
      additions.push('area: docs');
    } else if (selected.length === 0 && inferredType === 'security-contact') {
      additions.push('area: security');
    }
  }

  const effectiveSecurityContact = current.has('type: security-contact') || inferredType === 'security-contact';
  if (!current.has('privacy: review-needed') && (effectiveSecurityContact || isExplicitExposure(issue, form))) {
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

async function readLabelEvents(github, owner, repo, issueNumber) {
  if (typeof github.paginate !== 'function' || typeof github.rest.issues.listEvents !== 'function') {
    return { ok: false, events: [] };
  }
  try {
    const events = await github.paginate(github.rest.issues.listEvents, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    return { ok: true, events };
  } catch {
    return { ok: false, events: [] };
  }
}

function labelsProvenAddedByRun({ before, after, additions, automationLogin }) {
  if (!before.ok || !after.ok) return new Set();
  const beforeIds = new Set(before.events.filter(event => event.id != null).map(event => String(event.id)));
  const proven = new Set();
  for (const name of additions) {
    const labeled = after.events.filter(event => event.event === 'labeled' && event.label?.name === name);
    const newlyObserved = labeled.filter(event => event.id != null && !beforeIds.has(String(event.id)));
    const latest = labeled.at(-1);
    if (newlyObserved.length !== 1 || latest?.id == null || String(latest.id) !== String(newlyObserved[0].id)) continue;
    if (latest.actor?.login === automationLogin && latest.actor?.type === 'Bot') proven.add(name);
  }
  return proven;
}

async function triageLatestIssue({ github, owner, repo, issueNumber, automationLogin }) {
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

  const eventsBeforeWrite = await readLabelEvents(github, owner, repo, issueNumber);
  await github.rest.issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels: additions,
  });

  const afterWrite = await getIssue(github, owner, repo, issueNumber);
  const eventsAfterWrite = await readLabelEvents(github, owner, repo, issueNumber);
  const addedNames = new Set(additions);
  const withoutThisRun = {
    ...afterWrite,
    labels: (afterWrite.labels ?? []).filter(label => !addedNames.has(typeof label === 'string' ? label : label.name)),
  };
  const stillExpected = new Set(labelsForIssue(withoutThisRun));
  const stale = additions.filter(name => !stillExpected.has(name));
  const provenAddedByRun = labelsProvenAddedByRun({
    before: eventsBeforeWrite,
    after: eventsAfterWrite,
    additions,
    automationLogin,
  });
  const compensated = stale.filter(name => provenAddedByRun.has(name));
  const compensationSkipped = stale.filter(name => !provenAddedByRun.has(name));
  const compensationFailures = [];
  for (const name of compensated) {
    try {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name });
    } catch (error) {
      if (error.status !== 404) compensationFailures.push(error);
    }
  }
  if (compensationFailures.length > 0) {
    throw new AggregateError(compensationFailures, `Failed to compensate ${compensationFailures.length} stale triage label(s).`);
  }
  return { additions, ensured, compensated, compensationSkipped };
}

export async function triageIssue({ github, owner, repo, issueNumber, issue, automationLogin = 'github-actions[bot]' }) {
  const number = issueNumber ?? issue?.number;
  if (!Number.isInteger(number) || number <= 0) throw new Error('A positive issue number is required.');
  const key = `${owner}/${repo}#${number}`.toLowerCase();
  const previous = issueTriageQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => triageLatestIssue({ github, owner, repo, issueNumber: number, automationLogin }));
  issueTriageQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (issueTriageQueues.get(key) === current) issueTriageQueues.delete(key);
  }
}
