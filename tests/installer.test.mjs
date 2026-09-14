import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, symlinkSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const installer = resolve(packageRoot, 'install.mjs');
const outputRoot = resolve(packageRoot, 'tests/test-output');
mkdirSync(outputRoot, { recursive: true });
const root = mkdtempSync(join(outputRoot, 'installer-'));
const dshPackage = resolve(root, 'sdk/package.json');
const llmRoot = resolve(root, 'sdk/node_modules/@deepseek-ai/dsh-llm');
mkdirSync(llmRoot, { recursive: true });
writeFileSync(dshPackage, JSON.stringify({ name: '@deepseek-ai/dsh', type: 'module' }));
writeFileSync(resolve(llmRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', type: 'module', exports: './index.mjs' }));
writeFileSync(resolve(llmRoot, 'index.mjs'), 'export const isAgentLoopRequest = value => value?.testLoop === true;\n');
const presetId = 'reasoning-support';
const settings = 'agent-presets:\n  default: standard\nmodel-selection:\n  provider: unchanged-provider\n  model: unchanged-model\nother:\n  enabled: true\n';
const original = { 'agent.cordis.yml': '# Previous owned composition\n', 'preset.yml': 'name: Previous preview\n' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(name, existing = true) {
  const home = resolve(root, name);
  const target = resolve(home, '.agent-presets', presetId);
  mkdirSync(target, { recursive: true });
  writeFileSync(resolve(home, 'settings.yaml'), settings);
  writeFileSync(resolve(target, 'keep.txt'), 'Unrelated file must survive.');
  if (existing) for (const [file, content] of Object.entries(original)) writeFileSync(resolve(target, file), content);
  return { home, target };
}

function run(home, args = [], preloads = []) {
  return spawnSync(process.execPath, [...preloads, installer, '--dsh-home', home, '--dsh-package', dshPackage, ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true });
}

function installed(f, args = ['--set-default', '--expect-default', 'standard']) {
  const result = run(f.home, args);
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.installed, true);
  assert.equal(info.otherSettingsUnchanged, true);
  return info;
}

function rollback(f, receiptPath) {
  const result = run(f.home, ['--rollback', receiptPath]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function unchanged(f, expectedSettings = settings) {
  for (const [file, content] of Object.entries(original)) assert.equal(readFileSync(resolve(f.target, file), 'utf8'), content);
  assert.equal(readFileSync(resolve(f.home, 'settings.yaml'), 'utf8'), expectedSettings);
  assert.equal(readFileSync(resolve(f.target, 'keep.txt'), 'utf8'), 'Unrelated file must survive.');
}

test('existing install and exact rollback', () => {
  const f = fixture('existing');
  const info = installed(f);
  const composition = readFileSync(resolve(f.target, 'agent.cordis.yml'), 'utf8');
  assert.match(composition, /prefix: You are a helpful software engineer assistant\./);
  assert.match(composition, /allTools: true/);
  assert.match(composition, /reasoning-support-final-review/);
  assert.match(composition, /reasoning-support-analysis-pass/);
  assert.equal(readFileSync(resolve(f.home, 'settings.yaml'), 'utf8'), settings.replace('default: standard', `default: ${presetId}`));
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'manifest.json'), 'utf8'));
  for (const file of manifest.files) assert.equal(hash(readFileSync(resolve(f.target, 'runtime', manifest.runtimeVersion, file.name))), file.sha256);
  assert.equal(rollback(f, info.receiptPath).defaultRestored, true);
  unchanged(f);
});

test('installation without changing the default', () => {
  const f = fixture('no-default');
  const info = installed(f, []);
  assert.equal(info.defaultChanged, false);
  assert.equal(readFileSync(resolve(f.home, 'settings.yaml'), 'utf8'), settings);
  rollback(f, info.receiptPath);
  unchanged(f);
});

test('literal dollar sequences in settings survive installation and rollback', () => {
  const f = fixture('dollar-content');
  const unusual = settings.replace('  default: standard\n', () => "  default: standard\n  note: \"cost $$ $& $' $`\"\n");
  writeFileSync(resolve(f.home, 'settings.yaml'), unusual);
  const info = installed(f);
  assert.equal(readFileSync(resolve(f.home, 'settings.yaml'), 'utf8'), unusual.replace('default: standard', `default: ${presetId}`));
  rollback(f, info.receiptPath);
  unchanged(f, unusual);
});

test('first installation rollback keeps unrelated files and runtime', () => {
  const f = fixture('fresh', false);
  const info = installed(f);
  rollback(f, info.receiptPath);
  assert.equal(existsSync(resolve(f.target, 'agent.cordis.yml')), false);
  assert.equal(existsSync(resolve(f.target, 'preset.yml')), false);
  assert.equal(existsSync(resolve(f.target, 'runtime')), true);
  assert.equal(readFileSync(resolve(f.home, 'settings.yaml'), 'utf8'), settings);
  assert.equal(readFileSync(resolve(f.target, 'keep.txt'), 'utf8'), 'Unrelated file must survive.');
});

test('a changed default blocks installation before configuration writes', () => {
  const f = fixture('default-conflict');
  const result = run(f.home, ['--set-default', '--expect-default', 'a-different-default']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /default preset changed/);
  unchanged(f);
});

test('rollback preserves a later user model and preset selection', () => {
  const f = fixture('user-selection');
  const info = installed(f);
  const newer = settings.replace('standard', 'user-selected-preset').replace('unchanged-model', 'user-selected-model');
  writeFileSync(resolve(f.home, 'settings.yaml'), newer);
  assert.equal(rollback(f, info.receiptPath).concurrentDefaultPreserved, true);
  unchanged(f, newer);
});

test('modified configuration blocks rollback before restoring any other file', () => {
  const f = fixture('modified');
  const info = installed(f);
  const composition = readFileSync(resolve(f.target, 'agent.cordis.yml'));
  writeFileSync(resolve(f.target, 'preset.yml'), 'name: User edit\n');
  const result = run(f.home, ['--rollback', info.receiptPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Installed file was modified/);
  assert.ok(readFileSync(resolve(f.target, 'agent.cordis.yml')).equals(composition));
  assert.equal(readFileSync(resolve(f.target, 'preset.yml'), 'utf8'), 'name: User edit\n');
});

test('an actual interrupted installation has a usable pending rollback receipt', () => {
  const f = fixture('interrupted');
  const shim = resolve(root, 'fault-injection.mjs');
  writeFileSync(shim, `import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nconst originalRename = fs.renameSync;\nfs.renameSync = function (from, to) { if (String(to).replaceAll('\\\\', '/').endsWith('/preset.yml')) throw new Error('Injected second configuration write failure'); return originalRename(from, to); };\nsyncBuiltinESMExports();\n`);
  const result = run(f.home, ['--set-default'], ['--import', pathToFileURL(shim).href]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Injected second configuration write failure/);
  const backupRoot = resolve(f.home, '.reasoning-support-backups');
  const receiptPath = resolve(backupRoot, readdirSync(backupRoot)[0], 'installation.json');
  assert.equal(JSON.parse(readFileSync(receiptPath, 'utf8')).status, 'pending');
  assert.notEqual(readFileSync(resolve(f.target, 'agent.cordis.yml'), 'utf8'), original['agent.cordis.yml']);
  assert.equal(readFileSync(resolve(f.target, 'preset.yml'), 'utf8'), original['preset.yml']);
  assert.equal(rollback(f, receiptPath).defaultRestored, true);
  unchanged(f);
});

for (const broken of [false, true]) test(`runtime junction is rejected (${broken ? 'dangling' : 'existing'} destination)`, () => {
  const f = fixture(broken ? 'broken-junction' : 'junction');
  const outside = resolve(root, broken ? 'missing-outside' : 'outside');
  if (!broken) mkdirSync(outside);
  symlinkSync(outside, resolve(f.target, 'runtime'), 'junction');
  const result = run(f.home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing a symlink destination/);
  unchanged(f);
  assert.equal(existsSync(resolve(outside, 'adaptive-context.mjs')), false);
});


test('independent preset installation does not import or change unrelated custom style', () => {
  const f = fixture('independent-preset');
  const unrelated = resolve(f.home, '.agent-presets/existing-style');
  mkdirSync(unrelated, { recursive: true });
  const unrelatedFile = resolve(unrelated, 'agent.cordis.yml');
  const text = '# USER_STYLE_SENTINEL\n';
  writeFileSync(unrelatedFile, text);
  const info = installed(f);
  assert.doesNotMatch(readFileSync(resolve(f.target, 'agent.cordis.yml'), 'utf8'), /USER_STYLE_SENTINEL|existing-style/);
  assert.equal(readFileSync(unrelatedFile, 'utf8'), text);
  rollback(f, info.receiptPath);
  assert.equal(readFileSync(unrelatedFile, 'utf8'), text);
  unchanged(f);
});
