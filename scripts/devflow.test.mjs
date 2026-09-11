import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const managedPython = spawnSync('uv', ['python', 'find', '>=3.12'], {encoding: 'utf8'});
const python = managedPython.status === 0 ? managedPython.stdout.trim() : 'python3';
const revision = '1'.repeat(40);
const checks = JSON.parse(execFileSync(python, ['-I', '-S', '-c', 'import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], "rb"))["checks"]))', new URL('../.devflow/checks.toml', import.meta.url).pathname], {encoding: 'utf8'}));

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devflow-launcher-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const repository = join(root, 'repository with spaces');
  const install = join(root, 'installed release');
  mkdirSync(join(repository, 'scripts'), {recursive: true});
  mkdirSync(join(repository, '.devflow'));
  copyFileSync(new URL('./devflow', import.meta.url), join(repository, 'scripts/devflow'));
  writeFileSync(join(repository, '.devflow/workflow.lock'), `schema_version = 1\nversion = "0.1.0"\nrevision = "${revision}"\n`);
  return {root, repository, install};
}

test('missing installation blocks before any private package fetch', t => {
  const f = fixture(t);
  const result = spawnSync(python, ['-I', '-S', join(f.repository, 'scripts/devflow'), 'doctor', '--json'], {env: {...process.env, DEVFLOW_INSTALL_ROOT: f.install}, encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BLOCKED: Workflow .* is not installed/);
});

test('launcher preserves arguments and selects its own checkout independent of cwd', t => {
  const f = fixture(t);
  const release = join(f.install, 'releases', revision);
  mkdirSync(release, {recursive: true});
  writeFileSync(join(release, '.devflow-release.json'), '{}');
  const bin = join(f.root, 'bin'); mkdirSync(bin);
  const output = join(f.root, 'observed.json');
  const fake = join(bin, 'uv');
  writeFileSync(fake, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.OBSERVED, JSON.stringify({argv:process.argv.slice(2),env:process.env}));\n`);
  chmodSync(fake, 0o700);
  const result = spawnSync(python, ['-I', '-S', join(f.repository, 'scripts/devflow'), 'work', 'show', '--work-id', 'literal $(do-not-execute)'], {cwd: f.root, env: {...process.env, PATH: `${bin}:${process.env.PATH}`, OBSERVED: output, DEVFLOW_INSTALL_ROOT: f.install, VIRTUAL_ENV: 'unrelated'}, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(actual.argv, ['run', '--frozen', '--project', release, 'devflow', '--repository', f.repository, '--release-root', f.install, 'work', 'show', '--work-id', 'literal $(do-not-execute)']);
  assert.equal(actual.env.UV_PROJECT_ENVIRONMENT, join(f.install, 'environments', revision));
  assert.equal(actual.env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(actual.env.VIRTUAL_ENV, undefined);
});

test('floating or malformed pins fail instead of selecting a release', t => {
  const f = fixture(t);
  for (const pin of ['main', '../unowned', 'a'.repeat(39)]) {
    writeFileSync(join(f.repository, '.devflow/workflow.lock'), `schema_version = 1\nrevision = "${pin}"\n`);
    const result = spawnSync(python, ['-I', '-S', join(f.repository, 'scripts/devflow'), 'doctor'], {env: {...process.env, DEVFLOW_INSTALL_ROOT: f.install}, encoding: 'utf8'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /full commit pin/);
  }
});

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
