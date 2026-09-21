import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LABEL_CATALOGUE } from './issue-label-catalogue.mjs';

function loadYaml(url) {
  const source = "require 'yaml'; require 'json'; puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), permitted_classes: [], permitted_symbols: [], aliases: false))";
  return JSON.parse(execFileSync('ruby', ['-e', source, fileURLToPath(url)], { encoding: 'utf8' }));
}

test('catalogue contains only supported classification and flag labels', () => {
  const names = Object.keys(LABEL_CATALOGUE);
  assert.ok(names.includes('type: maintenance'));
  assert.ok(names.includes('type: investigation'));
  assert.ok(names.includes('type: test'));
  assert.ok(names.includes('area: distribution'));
  assert.ok(names.includes('privacy: review-needed'));
  assert.ok(names.includes('release: possible-blocker'));
  assert.equal(names.some(name => name.startsWith('status: ')), false);
  for (const [name, definition] of Object.entries(LABEL_CATALOGUE)) {
    assert.match(name, /^(?:type|area|privacy|release): /);
    assert.match(definition.color, /^[0-9a-f]{6}$/);
    assert.ok(definition.description.endsWith('.'));
  }
});

test('all issue forms are valid YAML and use only declared non-status labels', async () => {
  const directory = new URL('../.github/ISSUE_TEMPLATE/', import.meta.url);
  const files = (await readdir(directory)).filter(file => file.endsWith('.yml'));
  assert.ok(files.length >= 7);
  for (const file of files) {
    const document = loadYaml(new URL(file, directory));
    if (file === 'config.yml') continue;
    assert.ok(Array.isArray(document.labels), file);
    for (const label of document.labels) {
      assert.equal(label.startsWith('status: '), false, `${file}: ${label}`);
      assert.ok(LABEL_CATALOGUE[label], `${file}: undeclared ${label}`);
    }
  }
});

test('triage workflow is valid YAML and delegates without rewriting definitions', async () => {
  const source = await readFile(new URL('../.github/workflows/issue-triage.yml', import.meta.url), 'utf8');
  const workflow = loadYaml(new URL('../.github/workflows/issue-triage.yml', import.meta.url));
  assert.equal(workflow.name, 'Issue Triage');
  assert.match(source, /triageIssue/);
  assert.doesNotMatch(source, /updateLabel|status: needs triage/);
});
