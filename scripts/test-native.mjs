import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, symlinkSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const index = process.argv.indexOf('--dsh-package');
const packagePath = resolve(index >= 0 ? process.argv[index + 1] : process.env.DSH_PACKAGE ?? join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/package.json'));
if (!existsSync(packagePath)) throw new Error('Pass --dsh-package pointing to an installed DSH package.json.');
const requireDsh = createRequire(packagePath);
const output = resolve(root, 'tests/test-output');
mkdirSync(output, { recursive: true });
const home = mkdtempSync(join(output, 'native-'));
const profile = join(home, 'profiles/validation');
mkdirSync(profile, { recursive: true });
writeFileSync(join(home, 'settings.yaml'), 'agent-presets:\n  default: reasoning-support\n');
writeFileSync(join(home, '.credentials.yaml'), '{}\n');
writeFileSync(join(profile, 'cordis.yml'), '[]\n');
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'reasoning-support-native-validation', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2));
symlinkSync(join(dirname(packagePath), 'node_modules'), join(profile, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const installed = spawnSync(process.execPath, [join(root, 'install.mjs'), '--dsh-home', home, '--dsh-package', packagePath], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
if (installed.status !== 0) throw new Error(installed.stderr || 'Test preset installation failed');
const composition = join(home, '.agent-presets/reasoning-support/agent.cordis.yml');
writeFileSync(composition, readFileSync(composition, 'utf8').replace('    llmModule:', '    checkpoint: true\n    llmModule:'));
const disabled = ['llm-deepseek', 'llm-pi-ai', 'session-title-llm', 'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search',
  'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal', 'plan-mode', 'compaction-basic', 'command-compact', 'tool-result-pruner',
  'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork', 'workflow-worker-thread', 'tool-workflow', 'tool-ralph',
  'agent-instructions', 'tool-todo', 'tool-web'];
const patch = [
  { id: 'settings', config: { path: join(home, 'settings.yaml') } },
  { id: 'credentials', config: { path: join(home, '.credentials.yaml') } },
  ...disabled.map(id => ({ id, disabled: true })),
  { insert: [
    { id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings' },
    { id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: { default: 'reasoning-support', roots: [{ path: join(home, '.agent-presets'), trust: 'user' }] } },
    { id: 'reasoning-support-native-validation', name: join(root, 'tests/native-loop.mjs'), config: { home, llmModule: pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-llm')).href } },
  ] },
];
writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify(patch, null, 2));
const result = spawnSync(process.execPath, [join(dirname(packagePath), 'lib/bin.js'), '--profile', 'validation'], {
  cwd: root, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024,
});
writeFileSync(join(home, 'runner.log'), (result.stdout ?? '') + (result.stderr ?? ''));
const resultPath = join(home, 'native-validation.json');
if (existsSync(resultPath)) console.log(readFileSync(resultPath, 'utf8'));
else console.error((result.stderr || result.stdout || result.error?.message || 'Native validation returned no result').slice(-6000));
console.log(JSON.stringify({ resultPath, exitCode: result.status }));
process.exitCode = result.status === 0 ? 0 : 1;
