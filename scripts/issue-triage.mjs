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
const SENSITIVE_PHRASES = [
  ['api', 'key'], ['api', 'keys'],
  ['private', 'data'], ['personal', 'data'], ['profile', 'fact'], ['profile', 'facts'],
  ['generated', 'material'], ['generated', 'materials'], ['browser', 'profile'], ['browser', 'profiles'],
  ['sqlite', 'database'], ['sqlite', 'databases'], ['exploit', 'detail'], ['exploit', 'details'],
  ['secret'], ['secrets'], ['token'], ['tokens'], ['credential'], ['credentials'],
  ['password'], ['passwords'], ['resume'], ['resumes'],
].sort((left, right) => right.length - left.length);
const PLURAL_SENSITIVE_WORDS = new Set(['keys', 'secrets', 'tokens', 'credentials', 'passwords', 'facts', 'resumes', 'materials', 'profiles', 'databases', 'details', 'data']);
const EXPOSURE_ACTIONS = new Map([
  ['expose', 'base'], ['exposes', 'finite'], ['exposed', 'past'], ['exposing', 'progressive'], ['exposure', 'noun'],
  ['leak', 'base'], ['leaks', 'finite'], ['leaked', 'past'], ['leaking', 'progressive'],
  ['log', 'base'], ['logs', 'finite'], ['logged', 'past'], ['logging', 'progressive'],
  ['print', 'base'], ['prints', 'finite'], ['printed', 'past'], ['printing', 'progressive'],
  ['show', 'base'], ['shows', 'finite'], ['showed', 'past'], ['shown', 'past'], ['showing', 'progressive'],
  ['display', 'base'], ['displays', 'finite'], ['displayed', 'past'], ['displaying', 'progressive'],
  ['reveal', 'base'], ['reveals', 'finite'], ['revealed', 'past'], ['revealing', 'progressive'],
  ['disclose', 'base'], ['discloses', 'finite'], ['disclosed', 'past'], ['disclosing', 'progressive'],
  ['publish', 'base'], ['publishes', 'finite'], ['published', 'past'], ['publishing', 'progressive'],
  ['commit', 'base'], ['commits', 'finite'], ['committed', 'past'], ['committing', 'progressive'],
  ['paste', 'base'], ['pastes', 'finite'], ['pasted', 'past'], ['pasting', 'progressive'],
  ['render', 'base'], ['renders', 'finite'], ['rendered', 'past'], ['rendering', 'progressive'],
  ['visible', 'adjective'], ['visibility', 'noun'],
  ['appear', 'surface'], ['appears', 'surface'], ['appeared', 'surface'], ['appearing', 'surface'],
]);
const EXPOSURE_SURFACES = new Set(['log', 'logs', 'output', 'response', 'responses', 'error', 'errors', 'console', 'terminal', 'ui', 'page', 'pages', 'screen', 'screens', 'issue', 'issues', 'commit', 'commits']);
const SURFACE_PREPOSITIONS = new Set(['in', 'into', 'on', 'via']);
const AUXILIARIES = new Set(['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'shall']);
const NEGATED_CONTRACTIONS = new Set(["doesn't", "don't", "didn't", "isn't", "aren't", "wasn't", "weren't", "hasn't", "haven't", "hadn't", "won't", "wouldn't", "can't", "couldn't", "shouldn't"]);
const COORDINATORS = new Set(['and', 'or', 'nor']);
const CONTRAST_CONNECTORS = new Set(['although', 'though', 'but', 'however', 'while', 'whereas']);
const ACTIVE_OBJECT_FILLERS = new Set(['the', 'a', 'an', 'these', 'those', 'our', 'your', 'raw', 'public', 'private', 'personal', 'customer', 'customers', 'user', 'users']);
const IMPLICIT_SURFACE_FILLERS = new Set(['the', 'a', 'an']);
const MAINTENANCE_NOUNS = new Set([
  'dependency', 'dependencies', 'documentation', 'docs', 'field', 'fields',
  'format', 'formatting', 'handling', 'maintenance', 'migration', 'output', 'outputs',
  'response', 'responses', 'rotation', 'schema', 'validation', 'workflow', 'workflows',
]);
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

function tokenizeExposureText(text) {
  return [...text.toLowerCase().matchAll(/[a-z]+(?:['’][a-z]+)?|[0-9]+|[;,.!?]|\n+/gi)]
    .map(match => ({
      value: match[0].includes('\n') ? '\n' : match[0].replaceAll('’', "'"),
      index: match.index,
    }));
}

function splitExposureAssertions(text) {
  const assertions = [];
  let tokens = [];
  let inheritsSubject = false;
  const flush = () => {
    if (tokens.length > 0) assertions.push({ tokens, inheritsSubject });
    tokens = [];
  };

  for (const token of tokenizeExposureText(text)) {
    if (token.value === '\n' || ['.', '!', '?'].includes(token.value)) {
      flush();
      inheritsSubject = false;
    } else if (token.value === ';' || CONTRAST_CONNECTORS.has(token.value)) {
      flush();
      inheritsSubject = true;
    } else {
      tokens.push(token);
    }
  }
  flush();
  return assertions;
}

function phraseMatches(tokens, start, phrase) {
  return phrase.every((word, offset) => tokens[start + offset]?.value === word);
}

function sensitiveObjects(tokens) {
  const candidates = [];
  for (let index = 0; index < tokens.length;) {
    const phrase = SENSITIVE_PHRASES.find(candidate => phraseMatches(tokens, index, candidate));
    if (!phrase) {
      index += 1;
      continue;
    }
    candidates.push({
      start: index,
      end: index + phrase.length - 1,
      plural: PLURAL_SENSITIVE_WORDS.has(phrase.at(-1)),
      negated: false,
    });
    index += phrase.length;
  }

  const objects = candidates.filter((candidate, index) => {
    let groupEnd = index;
    let current = candidate;
    while (groupEnd + 1 < candidates.length) {
      const next = candidates[groupEnd + 1];
      const between = tokens.slice(current.end + 1, next.start).map(token => token.value);
      if (between.length === 0 || !between.every(value => value === ',' || COORDINATORS.has(value))) break;
      groupEnd += 1;
      current = next;
    }
    return !MAINTENANCE_NOUNS.has(tokens[candidates[groupEnd].end + 1]?.value);
  });

  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index];
    const previous = tokens[object.start - 1]?.value;
    object.negated = ['no', 'neither', 'without'].includes(previous);
    const coordinated = objects[index - 1];
    if (!object.negated && coordinated?.negated) {
      const between = tokens.slice(coordinated.end + 1, object.start).map(token => token.value);
      object.negated = between.length > 0 && between.every(value => value === ',' || COORDINATORS.has(value));
    }
  }
  return objects;
}

function exposureActions(tokens) {
  return tokens.flatMap((token, index) => {
    const form = EXPOSURE_ACTIONS.get(token.value);
    const surfacePrefix = tokens.slice(Math.max(0, index - 4), index);
    const prepositionIndex = surfacePrefix.findLastIndex(candidate => SURFACE_PREPOSITIONS.has(candidate.value));
    const isSurfaceNoun = EXPOSURE_SURFACES.has(token.value)
      && prepositionIndex >= 0
      && surfacePrefix.slice(prepositionIndex + 1).every(candidate =>
        IMPLICIT_SURFACE_FILLERS.has(candidate.value)
        || ACTIVE_OBJECT_FILLERS.has(candidate.value)
        || isModifier(candidate.value));
    return form && !isSurfaceNoun ? [{ index, form, value: token.value }] : [];
  });
}

function tokenDistance(action, object) {
  if (object.end < action.index) return action.index - object.end - 1;
  if (action.index < object.start) return object.start - action.index - 1;
  return 0;
}

function nearestObject(action, objects) {
  let nearest;
  for (const object of objects) {
    const distance = tokenDistance(action, object);
    if (distance > 12) continue;
    if (!nearest || distance < nearest.distance) nearest = { ...object, distance };
  }
  return nearest;
}

function isModifier(value) {
  return value.endsWith('ly') || ['ever', 'yet', 'still', 'longer', 'currently'].includes(value);
}

function hasNegation(tokens, start, end) {
  const values = tokens.slice(Math.max(0, start), end).map(token => token.value);
  return values.some((value, index) =>
    ['not', 'never', 'cannot', 'without', 'neither'].includes(value)
    || NEGATED_CONTRACTIONS.has(value)
    || (value === 'no' && values[index + 1] === 'longer'));
}

function hasAuxiliary(tokens, start, end) {
  return tokens.slice(Math.max(0, start), end).some(token => AUXILIARIES.has(token.value));
}

function hasSurfaceAfter(tokens, index) {
  for (let cursor = index + 1; cursor < Math.min(tokens.length, index + 9); cursor += 1) {
    if (!SURFACE_PREPOSITIONS.has(tokens[cursor].value)) continue;
    return tokens.slice(cursor + 1, Math.min(tokens.length, cursor + 4))
      .some(token => EXPOSURE_SURFACES.has(token.value));
  }
  return false;
}

function activeObjectGapIsBounded(tokens, action, object) {
  return tokens.slice(action.index + 1, object.start).every(token =>
    token.value === ','
    || ACTIVE_OBJECT_FILLERS.has(token.value)
    || isModifier(token.value));
}

function relationshipIsSyntactic(tokens, action, object) {
  if (object.inherited) {
    return action.form !== 'progressive' || hasAuxiliary(tokens, 0, action.index);
  }
  if (action.index < object.start) return activeObjectGapIsBounded(tokens, action, object);

  const hasAux = hasAuxiliary(tokens, object.end + 1, action.index);
  if (action.form === 'progressive') return hasAux;
  if (action.form === 'base') {
    const meaningfulGap = tokens.slice(object.end + 1, action.index)
      .filter(token => token.value !== ',' && !isModifier(token.value));
    return hasAux || (object.plural && meaningfulGap.length === 0);
  }
  return true;
}

function actionNegation(tokens, action, object, previous) {
  const objectBeforeAction = object.inherited || object.end < action.index;
  const start = objectBeforeAction
    ? object.inherited ? 0 : object.end + 1
    : Math.max(0, ...sensitiveObjects(tokens)
      .filter(candidate => candidate.end < action.index)
      .map(candidate => candidate.end + 1));
  if (object.negated) return true;

  if (objectBeforeAction && previous?.negated) {
    const betweenActions = tokens.slice(previous.action.index + 1, action.index);
    const coordinatorIndex = betweenActions.findLastIndex(token => COORDINATORS.has(token.value));
    const restartedPredicate = coordinatorIndex >= 0
      ? betweenActions.slice(coordinatorIndex + 1)
      : [];
    if (restartedPredicate.some(token => AUXILIARIES.has(token.value) || NEGATED_CONTRACTIONS.has(token.value))) {
      return hasNegation(restartedPredicate, 0, restartedPredicate.length);
    }
  }

  if (hasNegation(tokens, start, action.index)) return true;

  if (previous?.negated && !objectBeforeAction) {
    const between = tokens.slice(previous.action.index + 1, action.index).map(token => token.value);
    if (between.some(value => COORDINATORS.has(value))) return true;
  }
  return false;
}

function implicitSurfaceExposure(tokens, objects, actions) {
  for (const object of objects) {
    if (!object.inherited && actions.some(action => tokenDistance(action, object) <= 12)) continue;
    const start = object.inherited ? 0 : object.end + 1;
    for (let cursor = start; cursor < Math.min(tokens.length, start + 9); cursor += 1) {
      if (!SURFACE_PREPOSITIONS.has(tokens[cursor].value)) continue;
      const surface = tokens.slice(cursor + 1, Math.min(tokens.length, cursor + 4))
        .some(token => EXPOSURE_SURFACES.has(token.value));
      if (!surface) continue;
      const fillers = tokens.slice(start, cursor);
      const bounded = fillers.every(token =>
        token.value === ','
        || AUXILIARIES.has(token.value)
        || NEGATED_CONTRACTIONS.has(token.value)
        || IMPLICIT_SURFACE_FILLERS.has(token.value)
        || ['not', 'never', 'no', 'longer', 'cannot'].includes(token.value)
        || isModifier(token.value));
      if (bounded && !object.negated && !hasNegation(tokens, start, cursor)) return true;
    }
  }
  return false;
}

function assertionExposure(tokens, inheritedSubjects) {
  const localObjects = sensitiveObjects(tokens);
  const objects = localObjects.length > 0
    ? localObjects
    : inheritedSubjects.map(subject => ({ ...subject, start: -1, end: -1, negated: false, inherited: true }));
  const actions = exposureActions(tokens);
  let previous;

  for (const action of actions) {
    const object = nearestObject(action, localObjects)
      ?? (objects[0]?.inherited ? objects[0] : undefined);
    if (!object || !relationshipIsSyntactic(tokens, action, object)) continue;
    if (action.form === 'surface' && !hasSurfaceAfter(tokens, action.index)) continue;

    const negated = actionNegation(tokens, action, object, previous);
    if (!negated) return { exposure: true, subjects: localObjects };
    previous = { action, object, negated };
  }

  return {
    exposure: implicitSurfaceExposure(tokens, objects, actions),
    subjects: localObjects,
  };
}

function isExplicitExposure(issue, form) {
  let inheritedSubjects = [];
  for (const assertion of splitExposureAssertions(privacyText(issue, form))) {
    if (!assertion.inheritsSubject) inheritedSubjects = [];
    const result = assertionExposure(assertion.tokens, inheritedSubjects);
    if (result.exposure) return true;
    if (result.subjects.length > 0) {
      inheritedSubjects = result.subjects.map(subject => ({ ...subject, negated: false }));
    }
  }
  return false;
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
