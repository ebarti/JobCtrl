export const LABEL_CATALOGUE = Object.freeze({
  'type: bug': Object.freeze({ color: 'd73a4a', description: 'Broken or incorrect behavior.' }),
  'type: documentation': Object.freeze({ color: '0075ca', description: 'Documentation issue or improvement.' }),
  'type: feature': Object.freeze({ color: 'a2eeef', description: 'New capability or product improvement.' }),
  'type: investigation': Object.freeze({ color: 'd4c5f9', description: 'A bounded decision, measurement, or reproduction is needed before implementation.' }),
  'type: maintenance': Object.freeze({ color: '6e7781', description: 'Refactoring, tooling, dependencies, or maintenance without a new product capability.' }),
  'type: qa-regression': Object.freeze({ color: 'b60205', description: 'Visible regression in a product or QA flow.' }),
  'type: question': Object.freeze({ color: 'd876e3', description: 'Usage, setup, or contributor-workflow question.' }),
  'type: security-contact': Object.freeze({ color: 'ee0701', description: 'Public request for a private vulnerability contact path.' }),
  'type: test': Object.freeze({ color: 'bfd4f2', description: 'A missing regression or operational proof for an existing contract.' }),
  'area: api': Object.freeze({ color: 'c2e0c6', description: 'TypeScript API or API contract.' }),
  'area: browser-extension': Object.freeze({ color: 'c2e0c6', description: 'Browser extension capture or autofill.' }),
  'area: cli-worker': Object.freeze({ color: 'c2e0c6', description: 'Python CLI, worker, or automation engine.' }),
  'area: distribution': Object.freeze({ color: 'c2e0c6', description: 'Published package, installer, release, update, rollback, or uninstall.' }),
  'area: docs': Object.freeze({ color: 'c2e0c6', description: 'Repository or published documentation.' }),
  'area: github': Object.freeze({ color: 'c2e0c6', description: 'GitHub workflows, templates, or contribution metadata.' }),
  'area: security': Object.freeze({ color: 'c2e0c6', description: 'Security posture or private-reporting coordination.' }),
  'area: setup': Object.freeze({ color: 'c2e0c6', description: 'Install, setup, or local environment.' }),
  'area: web': Object.freeze({ color: 'c2e0c6', description: 'React web app or frontend product flow.' }),
  'privacy: review-needed': Object.freeze({ color: '5319e7', description: 'Maintainers should check the public issue for sensitive data exposure.' }),
  'release: possible-blocker': Object.freeze({ color: 'e99695', description: 'May block a public release, install path, or documented first-run flow.' }),
});

export const LEGACY_TYPE_ALIASES = Object.freeze({
  bug: 'type: bug',
  documentation: 'type: documentation',
  enhancement: 'type: feature',
  question: 'type: question',
});

export const SUPPORTED_LABEL_NAMES = Object.freeze(Object.keys(LABEL_CATALOGUE));

export function labelDefinition(name) {
  return LABEL_CATALOGUE[name];
}
