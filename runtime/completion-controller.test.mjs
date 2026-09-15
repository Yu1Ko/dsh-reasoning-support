import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReview, newReviewState, continuationPolicy, captureProof, queueCompletion, consumeCompletion, invalidate } from './completion-controller.mjs';
import { toolEvidence } from './request-context.mjs';

const limits = { maxRepairRounds: 2, maxRepairTimeMs: 300000, maxExtraTokens: 200000 };
const messages = (id = 'c1', error = false) => [
  { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Build and verify the artifact.' }] },
  { content: [{ type: 'tool-call', id, name: 'pwsh', arguments: '{"command":"npm test"}' }] },
  { content: [{ type: 'tool-result', toolCallId: id, isError: error, content: [{ type: 'text', text: error ? 'FAILED' : 'Passed' }] }] },
];
const finding = { requirement: 'The artifact must work.', observation: 'A required case is missing.', evidenceIds: ['tool:c1'], action: 'Implement the missing behavior.', verification: 'Run the required check.' };
const review = (status = 'needs_fix') => ({ status, answer: status === 'pass' ? 'Complete.' : 'One item remains.', issues: status === 'pass' ? [] : [finding] });
const makeState = () => {
  const queued = [], history = messages();
  const agent = { id: 'controller-test', session: { deriveMessages: () => history }, inbox: { nextStep: [], nextTurn: [] }, steer: m => queued.push(m) };
  const state = newReviewState(agent, { requestIds: ['u1'] }, 1);
  return { state, queued, history };
};

test('review rejects fabricated evidence and unsupported repair assertions', () => {
  const evidence = toolEvidence(messages());
  assert.throws(() => parseReview(JSON.stringify({ ...review(), issues: [{ ...finding, evidenceIds: ['tool:invented'] }] }), evidence), /reference/);
  const result = parseReview(JSON.stringify({ ...review(), issues: [{ ...finding, evidenceIds: ['request:u1'] }] }), evidence, [], ['u1']);
  assert.equal(result.status, 'needs_evidence');
});

test('an unresolved failed check cannot become pass merely because the reviewer says so', () => {
  const evidence = toolEvidence(messages('c1', true));
  const result = parseReview(JSON.stringify(review('pass')), evidence);
  assert.equal(result.status, 'needs_evidence');
  assert.deepEqual(result.issues[0].evidenceIds, ['tool:c1']);
  const resolved = toolEvidence([...messages('c1', true), ...messages('c2', false).slice(1)]);
  assert.equal(parseReview(JSON.stringify(review('pass')), resolved).status, 'pass');
});

test('unread required attachments prevent pass; an explained irrelevant file does not', () => {
  const file = { id: 'attachment:f', name: 'brief.pdf', status: 'needs_tool' };
  assert.equal(parseReview(JSON.stringify(review('pass')), toolEvidence([]), [file]).status, 'needs_evidence');
  assert.equal(parseReview(JSON.stringify({ ...review('pass'), materials: [{ id: file.id, notNeeded: true, reason: 'The user only asked for the file name.' }] }), toolEvidence([]), [file]).status, 'pass');
});

test('one stop decision steers once in the same turn, with plugin provenance', async () => {
  const { state, queued } = makeState();
  const proof = await captureProof(state);
  queueCompletion(state, review(), proof, { kind: 'continue' }, 'Unverified draft');
  await consumeCompletion(state, 1, new AbortController().signal, limits);
  await consumeCompletion(state, 1, new AbortController().signal, limits);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].source.kind, 'plugin');
  assert.equal(state.repairRounds, 1);
  assert.match(queued[0].content[0].text, /not user authorization/);
});

test('no progress, round, time and token budgets stop repairs and request an honest report', async () => {
  for (const [override, reason] of [
    [{ repairRounds: 2 }, 'repair-round-limit'],
    [{ reviewStartedAt: 1 }, 'repair-time-limit'],
    [{ usedTokens: 200000 }, 'auxiliary-token-limit'],
    [{ previousProgress: 'same' }, 'no-new-evidence-or-artifact'],
  ]) {
    const { state } = makeState();
    Object.assign(state, override);
    assert.equal(continuationPolicy(state, review(), 'same', limits).reason, reason);
  }
  const { state, queued } = makeState();
  state.repairRounds = 2;
  const proof = await captureProof(state);
  queueCompletion(state, review(), proof, continuationPolicy(state, review(), proof.fingerprint, limits), 'Draft');
  await consumeCompletion(state, 1, new AbortController().signal, limits);
  assert.equal(state.reporting, true);
  assert.match(queued[0].content[0].text, /Do not claim acceptance passed/);
});

test('new user input and cancellation invalidate pending repair work', async () => {
  const { state, queued } = makeState();
  const proof = await captureProof(state);
  queueCompletion(state, review(), proof, { kind: 'continue' }, 'Draft');
  state.agent.inbox.nextStep.push({ id: 'new-user', source: { kind: 'user' } });
  await consumeCompletion(state, 1, new AbortController().signal, limits);
  assert.equal(queued.length, 0);
  invalidate(state);
  assert.equal(state.abort.signal.aborted, true);
  assert.equal(state.pending, undefined);
  const other = makeState().state;
  queueCompletion(other, review(), await captureProof(other), { kind: 'continue' }, 'Draft');
  await assert.rejects(consumeCompletion(other, 1, AbortSignal.abort(new Error('cancelled')), limits), /cancelled/);
});

test('artifact changes during review invalidate a previously passing decision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reasoning-proof-'));
  await writeFile(join(root, 'artifact.txt'), 'version one');
  const { state, history, queued } = makeState();
  state.agent.session.header = { cwd: root };
  history.push({ content: [{ type: 'tool-call', id: 'read1', name: 'read', arguments: '{"file_path":"artifact.txt"}' }] },
    { content: [{ type: 'tool-result', toolCallId: 'read1', content: [{ type: 'text', text: 'version one' }] }] });
  const before = await captureProof(state);
  await writeFile(join(root, 'artifact.txt'), 'version two');
  assert.notEqual((await captureProof(state)).fingerprint, before.fingerprint);
  queueCompletion(state, review('pass'), before, { kind: 'deliver' }, 'Complete');
  await consumeCompletion(state, 1, new AbortController().signal, limits);
  assert.equal(queued.length, 1);
  assert.match(queued[0].content[0].text, /current version/);
});

test('artifact observation does not follow a workspace junction to outside files', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reasoning-path-'));
  const root = join(base, 'workspace'), outside = join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(join(outside, 'private.txt'), 'do not read');
  await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const { state, history } = makeState();
  state.agent.session.header = { cwd: root };
  history.push({ content: [{ type: 'tool-call', id: 'read2', name: 'read', arguments: '{"file_path":"link/private.txt"}' }] },
    { content: [{ type: 'tool-result', toolCallId: 'read2', content: [{ type: 'text', text: 'result' }] }] });
  assert.equal((await captureProof(state)).artifacts.length, 0);
});

test('an unresolved failure cannot disappear when model-facing evidence is excerpted', () => {
  const result = (command, id, error) => [
    { content: [{ type: 'tool-call', id, name: 'pwsh', arguments: JSON.stringify({ command }) }] },
    { content: [{ type: 'tool-result', toolCallId: id, isError: error, content: [{ type: 'text', text: error ? 'failed' : 'passed' }] }] },
  ];
  const history = result('old-required-check', 'old', true);
  for (let i = 0; i < 8; i++) history.push(...result(`check-${i}`, `failed-${i}`, true));
  for (let i = 0; i < 30; i++) history.push(...result(`unrelated-${i}`, `other-${i}`, false));
  for (let i = 0; i < 8; i++) history.push(...result(`check-${i}`, `resolved-${i}`, false));
  const evidence = toolEvidence(history);
  assert.equal(evidence.records.some(record => record.id === 'tool:old'), false);
  const decision = parseReview(JSON.stringify(review('pass')), evidence);
  assert.equal(decision.status, 'needs_evidence');
  assert.ok(decision.issues.some(item => item.evidenceIds.includes('tool:old')));
});
