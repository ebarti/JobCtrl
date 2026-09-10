const areas = new Map([
  ['Web app', 'web'], ['Dashboard or Jobs', 'web'], ['Apply Review', 'web'],
  ['Artifacts', 'web'], ['Profile or Settings', 'web'],
  ['TypeScript API', 'api'], ['Python worker or CLI', 'cli-worker'],
  ['CLI or worker', 'cli-worker'], ['Browser extension', 'browser-extension'],
  ['Documentation', 'docs'], ['Documentation site', 'docs'],
  ['Setup or install', 'setup'], ['GitHub workflows', 'github'],
  ['GitHub workflow', 'github'], ['Contributor workflow', 'github'],
]);
const types = new Map([
  ['bug', 'bug'], ['feature', 'feature'], ['qa', 'qa-regression'],
  ['docs', 'documentation'], ['question', 'question'],
  ['security contact', 'security-contact'],
]);

function fields(body) {
  const result = new Map();
  for (const match of body.replaceAll('\r\n', '\n').matchAll(/^### ([^\n]+)\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)) {
    const key = match[1].trim();
    // Ambiguous duplicated fields are left for triage.
    result.set(key, result.has(key) ? null : match[2].trim());
  }
  return result;
}

export function labelsForIssue(issue) {
  const current = new Set((issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name));
  const additions = new Set();
  if (![...current].some(label => label.startsWith('status: '))) additions.add('status: needs triage');
  const title = issue.title ?? '';
  const declaredType = types.get(title.match(/^\[(bug|feature|qa|docs|question|security contact)\]:/i)?.[1].toLowerCase());
  if (declaredType && ![...current].some(label => label.startsWith('type: '))) additions.add(`type: ${declaredType}`);
  const form = fields(issue.body ?? '');
  const selected = ['Affected area', 'Area', 'Regression surface'].filter(key => form.has(key));
  if (selected.length === 1) {
    const area = areas.get(form.get(selected[0]));
    if (area) additions.add(`area: ${area}`);
  } else if (selected.length === 0 && ![...current].some(label => label.startsWith('area: '))) {
    // Title-only fallback for blank issues. Never scan safety boilerplate.
    if (/\b(?:docs?|readme|documentation)\b/i.test(title)) additions.add('area: docs');
    else if (/\b(?:install|setup)\b/i.test(title)) additions.add('area: setup');
  }
  if (current.has('type: security-contact') || additions.has('type: security-contact')) {
    additions.add('area: security');
    additions.add('privacy: review-needed');
  } else if (/\b(?:security|vulnerabilit(?:y|ies)|secrets?|credentials?|tokens?|api keys?|private data)\b/i.test(title)) {
    additions.add('privacy: review-needed');
  }
  if (/^- \[[xX]\] This appears to block a public release, source install, or documented first-run flow\.$/m.test(form.get('Release impact') ?? '')) {
    additions.add('release: possible-blocker');
  }
  return [...additions].filter(label => !current.has(label));
}
