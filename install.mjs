import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, renameSync, lstatSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const part = relative(root, file); return part !== '' && !part.startsWith('..') && !isAbsolute(part); };
const presetId = 'reasoning-support'; // Sessions explicitly select this independent preset.
const fileNames = ['agent.cordis.yml', 'preset.yml'];

function checkPath(root, file) {
  if (root !== file && !inside(root, file)) throw new Error(`Path escaped its root: ${file}`);
  let current = root;
  for (const part of ['', ...relative(root, file).split(/[\\/]/).filter(Boolean)]) {
    current = resolve(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Refusing a symlink destination: ${current}`);
  }
}

function atomicWrite(file, bytes, expected) {
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Refusing a symlink file: ${file}`);
  const current = existsSync(file) ? readFileSync(file) : undefined;
  if ((current === undefined) !== (expected === undefined) || (current && !current.equals(expected))) throw new Error(`File changed concurrently: ${file}`);
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' });
    const recheck = existsSync(file) ? readFileSync(file) : undefined;
    if ((recheck === undefined) !== (expected === undefined) || (recheck && !recheck.equals(expected))) throw new Error(`File changed before replacement: ${file}`);
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

const rollbackPath = option('--rollback');
if (rollbackPath) {
  const receiptPath = resolve(rollbackPath);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const home = resolve(receipt.dshHome);
  const target = resolve(home, '.agent-presets', presetId);
  const backupRoot = resolve(receipt.backupRoot);
  if (receipt.schema !== 1 || receipt.presetId !== presetId || resolve(receipt.target) !== target || !inside(resolve(home, '.reasoning-support-backups'), backupRoot) || receiptPath !== resolve(backupRoot, 'installation.json')) throw new Error('Invalid rollback paths');
  checkPath(home, target);
  checkPath(home, receiptPath);
  const restores = [];
  for (const name of fileNames) {
    const file = resolve(target, name);
    const original = resolve(backupRoot, name);
    checkPath(home, file);
    checkPath(home, original);
    const before = receipt.existed[name] ? readFileSync(original) : undefined;
    if (before && hash(before) !== receipt.originalHashes[name]) throw new Error(`Backup was modified: ${name}`);
    const current = existsSync(file) ? readFileSync(file) : undefined;
    if (current === undefined && before === undefined || current && before && current.equals(before)) continue;
    if (!current || hash(current) !== receipt.installedHashes[name]) throw new Error(`Installed file was modified; inspect manually: ${name}`);
    restores.push({ file, before, current });
  }
  for (const { file, before, current } of restores) {
    if (before) atomicWrite(file, before, current);
    else {
      if (!readFileSync(file).equals(current)) throw new Error(`File changed during rollback: ${file}`);
      unlinkSync(file); // Exact verified configuration file only; runtime and history stay intact.
    }
  }
  let defaultRestored = !receipt.defaultChanged;
  if (receipt.defaultChanged) {
    const settingsPath = resolve(home, 'settings.yaml');
    checkPath(home, settingsPath);
    const current = readFileSync(settingsPath, 'utf8');
    const match = current.match(/^agent-presets:\r?\n[\s\S]*?(?=^\S|(?![\s\S]))/m);
    if (match?.[0] === receipt.installedPresetBlock) {
      atomicWrite(settingsPath, current.replace(match[0], () => receipt.originalPresetBlock), Buffer.from(current));
      defaultRestored = true;
    } else defaultRestored = match?.[0] === receipt.originalPresetBlock;
  }
  atomicWrite(receiptPath, JSON.stringify({ ...receipt, status: 'rolled-back', defaultRestored, restoredAt: new Date().toISOString() }, null, 2), readFileSync(receiptPath));
  console.log(JSON.stringify({ restored: true, presetId, target, defaultRestored, concurrentDefaultPreserved: !defaultRestored }));
  process.exit(0);
}

const dshHome = resolve(option('--dsh-home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
const defaultPackage = process.platform === 'win32' && process.env.APPDATA
  ? join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/package.json') : undefined;
const packageOption = option('--dsh-package') ?? process.env.DSH_PACKAGE ?? defaultPackage;
if (!packageOption || !existsSync(resolve(packageOption))) throw new Error('Pass --dsh-package with the package.json path of your installed @deepseek-ai/dsh package.');
const dshPackage = resolve(packageOption);
const requireDsh = createRequire(dshPackage);
const llmModule = pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-llm')).href;
if (typeof (await import(llmModule)).isAgentLoopRequest !== 'function') throw new Error('The installed DSH is missing the required request identity API');
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'manifest.json'), 'utf8'));
if (!/^[a-f0-9]{16}$/.test(manifest.runtimeVersion)) throw new Error('Invalid runtime version');
for (const file of manifest.files) {
  if (!/^[a-z0-9-]+\.mjs$/.test(file.name) || hash(readFileSync(resolve(packageRoot, 'runtime', file.name))) !== file.sha256) throw new Error(`Package file verification failed: ${file.name}`);
}
const presetRoot = resolve(dshHome, '.agent-presets');
const target = resolve(presetRoot, presetId);
if (!inside(presetRoot, target)) throw new Error('Invalid preset destination');
checkPath(dshHome, target);
const base = readFileSync(resolve(packageRoot, 'base.agent.cordis.yml'), 'utf8');
if (/name:\s*.*(?:analysis-pass|final-review)\.mjs/.test(base)) throw new Error('The base already contains reasoning support; refusing duplicate middleware');
const entryPattern = /^(\s*name:\s*)['"]?\.\/(?:runtime\/[a-f0-9]+\/)?adaptive-context\.mjs['"]?[ \t]*$/gm;
if ([...base.matchAll(entryPattern)].length !== 1) throw new Error('The base context plugin entry was not found uniquely');
const runtimeName = './runtime/' + manifest.runtimeVersion;
const adaptedBase = base.replace(entryPattern, (_match, prefix) => prefix + runtimeName + '/adaptive-context.mjs');
const auditDirectory = resolve(dshHome, 'storages', 'reasoning-support-audit');
const composition = `- id: reasoning-support-final-review\n  name: ${runtimeName}/final-review.mjs\n  config:\n    llmModule: ${JSON.stringify(llmModule)}\n    auditDirectory: ${JSON.stringify(auditDirectory)}\n\n- id: reasoning-support-analysis-pass\n  name: ${runtimeName}/analysis-pass.mjs\n  config:\n    auditDirectory: ${JSON.stringify(auditDirectory)}\n\n` + adaptedBase;
const metadata = 'name: Reasoning Support\ndescription: Native tools and project rules with context shaping, optional same-model advice and final review. No bundled roleplay identity.\norder: 2\n';
const settingsPath = resolve(dshHome, 'settings.yaml');
checkPath(dshHome, settingsPath);
if (!existsSync(settingsPath)) throw new Error('Initialize DSH and configure a model provider before installing this preset.');
const settingsBefore = readFileSync(settingsPath, 'utf8');
const presetBlock = settingsBefore.match(/^agent-presets:\r?\n[\s\S]*?(?=^\S|(?![\s\S]))/m)?.[0];
const expectedDefault = option('--expect-default');
if (expectedDefault !== undefined && presetBlock?.match(/^[ \t]+default:\s*([^\r\n]*)/m)?.[1]?.trim() !== expectedDefault) throw new Error('The default preset changed; no configuration was written');
let settingsAfter = settingsBefore, installedPresetBlock = presetBlock;
if (args.includes('--set-default')) {
  if (!presetBlock || !/^[ \t]+default:/m.test(presetBlock)) throw new Error('Could not locate the existing preset-default setting');
  installedPresetBlock = presetBlock.replace(/^([ \t]+default:)[^\r\n]*/m, '$1 ' + presetId);
  settingsAfter = settingsBefore.replace(presetBlock, () => installedPresetBlock);
}
const backupRoot = resolve(dshHome, '.reasoning-support-backups', new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8));
if (!inside(resolve(dshHome, '.reasoning-support-backups'), backupRoot)) throw new Error('Invalid backup destination');
checkPath(dshHome, backupRoot);
mkdirSync(backupRoot, { recursive: true });
const before = {}, existed = {};
for (const name of fileNames) {
  const file = resolve(target, name);
  checkPath(dshHome, file);
  existed[name] = existsSync(file);
  before[name] = existed[name] ? readFileSync(file) : undefined;
  if (existed[name]) copyFileSync(file, resolve(backupRoot, name));
}
const runtimeTarget = resolve(target, 'runtime', manifest.runtimeVersion);
if (!inside(target, runtimeTarget)) throw new Error('Runtime escaped the preset folder');
checkPath(dshHome, runtimeTarget);
mkdirSync(runtimeTarget, { recursive: true });
for (const file of manifest.files) {
  const destination = resolve(runtimeTarget, file.name);
  if (!inside(runtimeTarget, destination)) throw new Error('Runtime filename escaped its folder');
  checkPath(dshHome, destination);
  if (existsSync(destination)) {
    if (hash(readFileSync(destination)) !== file.sha256) throw new Error('An existing versioned runtime was modified');
  } else copyFileSync(resolve(packageRoot, 'runtime', file.name), destination);
}
const receipt = {
  schema: 1, status: 'pending',
  installedAt: new Date().toISOString(), presetId, dshHome, target, backupRoot, runtimeVersion: manifest.runtimeVersion,
  existed, originalHashes: Object.fromEntries(fileNames.map(name => [name, before[name] ? hash(before[name]) : null])),
  installedHashes: { 'agent.cordis.yml': hash(composition), 'preset.yml': hash(metadata) },
  defaultChanged: settingsAfter !== settingsBefore, originalPresetBlock: presetBlock, installedPresetBlock,
  settingsBeforeHash: hash(settingsBefore), settingsAfterHash: hash(settingsAfter),
  otherSettingsUnchanged: settingsAfter.replace(installedPresetBlock, () => presetBlock) === settingsBefore,
};
const receiptPath = resolve(backupRoot, 'installation.json');
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
try {
  atomicWrite(resolve(target, 'agent.cordis.yml'), composition, before['agent.cordis.yml']);
  atomicWrite(resolve(target, 'preset.yml'), metadata, before['preset.yml']);
  if (settingsAfter !== settingsBefore) atomicWrite(settingsPath, settingsAfter, Buffer.from(settingsBefore));
  receipt.status = 'installed';
  atomicWrite(receiptPath, JSON.stringify(receipt, null, 2), readFileSync(receiptPath));
} catch (error) {
  console.error(JSON.stringify({ installed: false, receiptPath, message: error.message }));
  process.exitCode = 1;
  throw error;
}
console.log(JSON.stringify({ installed: true, presetId, displayName: 'Reasoning Support', target, runtimeVersion: manifest.runtimeVersion, defaultChanged: receipt.defaultChanged, otherSettingsUnchanged: receipt.otherSettingsUnchanged, auditDirectory, receiptPath }, null, 2));
