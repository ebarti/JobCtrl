import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const managedPython = spawnSync('uv', ['python', 'find', '>=3.12'], {encoding: 'utf8'});
const python = managedPython.status === 0 ? managedPython.stdout.trim() : 'python3';
const checks = JSON.parse(execFileSync(python, ['-I', '-S', '-c', 'import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], "rb"))["checks"]))', new URL('./checks.toml', import.meta.url).pathname], {encoding: 'utf8'}));

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jobctrl-check-recipes-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const repository = join(root, 'repository with spaces');
  mkdirSync(join(repository, 'scripts'), {recursive: true});
  return {root, repository};
}

test('script recipe executes the selected files and writes JUnit at a path with spaces', t => {
  const f = fixture(t);
  const script = join(f.repository, 'scripts/recipe.test.mjs');
  const report = join(f.root, 'owned report.xml');
  const argv = checks.scripts.argv.map(value => value.replaceAll('{report_path}', report));
  const environment = {...process.env};
  delete environment.NODE_TEST_CONTEXT;
  for (const fails of [false, true]) {
    writeFileSync(script, `import test from 'node:test'; import assert from 'node:assert/strict'; test('actual recipe case', () => assert.equal(${fails}, false));`);
    rmSync(report, {force: true});
    const result = spawnSync(argv[0], argv.slice(1), {cwd: f.repository, env: environment, encoding: 'utf8'});
    assert.equal(result.status, fails ? 1 : 0, result.stderr);
    const xml = readFileSync(report, 'utf8');
    assert.match(xml, /<testcase[^>]*name="actual recipe case"/);
    assert.equal(xml.includes('<failure'), fails);
  }
});

test('diff recipe checks a clean committed multi-commit PR instead of only unstaged changes', t => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', args, {cwd: f.repository, encoding: 'utf8'}).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Workflow Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(f.repository, 'baseline.txt'), 'baseline\n');
  git('add', '.'); git('commit', '-qm', 'test: initialize fixture');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  git('switch', '-qc', 'test/committed-change');
  const changed = join(f.repository, 'change.txt');
  writeFileSync(changed, 'committed trailing space \n');
  git('add', '.'); git('commit', '-qm', 'test: introduce regression');
  writeFileSync(join(f.repository, 'unrelated.txt'), 'later commit\n');
  git('add', '.'); git('commit', '-qm', 'test: add unrelated file');
  assert.equal(git('status', '--porcelain'), '');
  const argv = checks.diff.argv;
  const bad = spawnSync(argv[0], argv.slice(1), {cwd: f.repository, encoding: 'utf8'});
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /trailing whitespace/);
  writeFileSync(changed, 'corrected line\n');
  git('add', '.'); git('commit', '-qm', 'test: repair regression');
  assert.equal(spawnSync(argv[0], argv.slice(1), {cwd: f.repository}).status, 0);
});
