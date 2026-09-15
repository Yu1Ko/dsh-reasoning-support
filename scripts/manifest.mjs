import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');
const names = ['adaptive-context.mjs', 'agent-context.mjs', 'discovery-schemas.mjs', 'reasoning-guidance.mjs', 'analysis-pass.mjs', 'final-review.mjs', 'target-model.mjs', 'audit.mjs', 'request-context.mjs', 'completion-controller.mjs'];
const files = names.map(name => ({ name, sha256: hash(readFileSync(resolve(root, 'runtime', name))) }));
const manifest = { packageVersion: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version, runtimeVersion: hash(JSON.stringify(files)).slice(0, 16), files };
const destination = resolve(root, 'manifest.json');
if (process.argv.includes('--check')) {
  if (JSON.stringify(JSON.parse(readFileSync(destination, 'utf8'))) !== JSON.stringify(manifest)) throw new Error('Runtime manifest is stale. Run npm run manifest after reviewing runtime changes.');
  console.log('Runtime manifest verified.');
} else {
  writeFileSync(destination, JSON.stringify(manifest, null, 2) + '\n');
  console.log(manifest.runtimeVersion);
}
