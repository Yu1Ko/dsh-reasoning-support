import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { recordAudit, latestAudit, readAuditRecords, auditPath } from './audit.mjs';

test('audit persists separately, is reloadable, and cannot escape via session id', () => {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), 'test-output', 'audit-' + randomUUID());
  const agent = { id: '../../outside/session', session: { append() { throw Error('Do not alter DSH journals'); } } };
  assert.ok(recordAudit(agent, 'reasoning-support/advice', { turn: 1, requestIds: ['u1'], advisoryAnswer: 'A public candidate.', usage: undefined }, directory));
  const rows = readAuditRecords(directory, agent.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].advisoryAnswer, 'A public candidate.');
  assert.equal(latestAudit(agent, 'reasoning-support/advice').turn, 1);
  assert.ok(auditPath(directory, agent.id).startsWith(directory));
  assert.match(auditPath(directory, agent.id), /[a-f0-9]{64}\.jsonl$/);
});
