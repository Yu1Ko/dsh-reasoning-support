import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const latest = new WeakMap();
const kinds = new Set(['reasoning-support/advice', 'reasoning-support/review', 'reasoning-support/control', 'reasoning-support/checkpoint']);

/** The harness home's audit directory, when the host publishes its path helper. */
export function defaultAuditDirectory(ctx) {
  const dshHomePath = ctx.get?.('dshHomePath');
  return typeof dshHomePath === 'function' ? dshHomePath('storages', 'reasoning-support-audit') : undefined;
}

export function auditPath(directory, sessionId) {
  const key = createHash('sha256').update(String(sessionId)).digest('hex');
  return resolve(directory, key + '.jsonl');
}

/** Diagnostics stay outside DSH's versioned session-event vocabulary. */
export function recordAudit(agent, type, data, directory) {
  if (!kinds.has(type)) throw new Error('Unsupported DSV4.1 audit type');
  let record;
  try {
    record = JSON.parse(JSON.stringify({ ...data, type, sessionId: String(agent.id), at: new Date().toISOString() }));
    if (directory !== undefined) {
      mkdirSync(directory, { recursive: true });
      appendFileSync(auditPath(directory, agent.id), JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    }
  } catch (error) {
    latest.delete(agent);
    console.warn(`[reasoning-support] Audit persistence failed (${error.code ?? error.name}); independent acceptance is unavailable.`);
    return false;
  }
  let records = latest.get(agent);
  if (!records) { records = new Map(); latest.set(agent, records); }
  records.set(type, record);
  return record;
}

export function latestAudit(agent, type) {
  return latest.get(agent)?.get(type);
}

export function readAuditRecords(directory, sessionId) {
  const file = auditPath(directory, sessionId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
