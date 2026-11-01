import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LABEL_CATALOGUE } from './issue-label-catalogue.mjs';
import { labelsForIssue } from './issue-triage.mjs';

function loadYaml(url) {
  const source = "require 'yaml'; require 'json'; puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), permitted_classes: [], permitted_symbols: [], aliases: false))";
  return JSON.parse(execFileSync('ruby', ['-e', source, fileURLToPath(url)], { encoding: 'utf8' }));
}

test('catalogue contains the fixed supported classifications and no progress labels', () => {
  const names = Object.keys(LABEL_CATALOGUE);
  for (const name of [
    'type: maintenance', 'type: investigation', 'type: test',
    'area: distribution', 'privacy: review-needed', 'release: possible-blocker',
  ]) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(names.some(name => name.startsWith('status: ')), false);
  for (const [name, definition] of Object.entries(LABEL_CATALOGUE)) {
    assert.match(name, /^(?:type|area|privacy|release): /);
    assert.match(definition.color, /^[0-9a-f]{6}$/);
    assert.ok(definition.description.endsWith('.'));
  }
});

test('the six issue forms use only declared non-status labels', async () => {
  const directory = new URL('../.github/ISSUE_TEMPLATE/', import.meta.url);
  const files = (await readdir(directory)).filter(file => file.endsWith('.yml') && file !== 'config.yml').sort();
  assert.deepEqual(files, [
    'bug_report.yml',
    'documentation.yml',
    'feature_request.yml',
    'qa_regression.yml',
    'security_contact.yml',
    'support_question.yml',
  ]);
  for (const file of files) {
    const document = loadYaml(new URL(file, directory));
    assert.ok(Array.isArray(document.labels), file);
    for (const label of document.labels) {
      assert.equal(label.startsWith('status: '), false, `${file}: ${label}`);
      assert.ok(LABEL_CATALOGUE[label], `${file}: undeclared ${label}`);
    }
    for (const field of document.body ?? []) {
      const label = field.attributes?.label;
      if (!['Affected area', 'Area', 'Regression surface'].includes(label)) continue;
      for (const option of field.attributes.options) {
        const labels = labelsForIssue({ state: 'open', title: 'Unclassified', body: `### ${label}\n\n${option}`, labels: [] });
        const areas = labels.filter(name => name.startsWith('area: '));
        if (['Unsure', 'Other'].includes(option)) assert.deepEqual(areas, [], `${file}: ${option}`);
        else assert.equal(areas.length, 1, `${file}: ${option}`);
      }
    }
  }
});

test('triage workflow serializes each issue and delegates without rewrite or compensation machinery', async () => {
  const url = new URL('../.github/workflows/issue-triage.yml', import.meta.url);
  const source = await readFile(url, 'utf8');
  const workflow = loadYaml(url);
  assert.equal(workflow.name, 'Issue Triage');
  assert.match(source, /group: issue-triage-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.issue\.number \|\| inputs\.issue_number \}\}/);
  assert.match(source, /cancel-in-progress: false/);
  assert.match(source, /triageIssue/);
  assert.doesNotMatch(source, /updateLabel|removeLabel|listEvents|status: needs triage/);
});
