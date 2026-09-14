import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, toolEvidence, reviewFinalStream, currentAdvisory } from './final-review.mjs';
import { latestAudit, recordAudit } from './audit.mjs';

const original = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'Wrong draft.' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'Wrong draft.' } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 35, cacheReadTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' }, replayState: { invalidAfterRewrite: true } },
];
const stream = async function* (values) { yield* values; };
const options = () => Object.freeze({ provider: 'route', model: 'codebuddy/deepseek-v4.1-flash', messages: [], signal: new AbortController().signal });
const state = () => ({ turn: 1, input: 'Exact user request', agent: { id: 'test-review', session: { append() { throw new Error('Audit must not append unknown DSH session events'); } } } });
const limits = { timeoutMs: 1000, maxTokens: 1024 };

test('final replacement preserves primary context accounting and records auxiliary usage separately', async () => {
  const calls = [], reviewState = state();
  const llm = { async *stream(o) { calls.push(o); yield { type: 'block-end', index: 0, block: { type: 'text', text: 'A corrected answer.' } }; yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  const request = options();
  const result = await Array.fromAsync(reviewFinalStream(request, stream(original), reviewState, llm, limits));
  const audit = latestAudit(reviewState.agent, 'reasoning-support/review');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tools, []);
  assert.equal(result.find(c => c.type === 'block-end').block.text, 'A corrected answer.');
  assert.equal(result.find(c => c.type === 'usage').usage.totalTokens, 35);
  assert.equal(result.find(c => c.type === 'usage').usage.inputTokens, 10);
  assert.equal(audit.usage.totalTokens, 10);
  assert.equal(result.at(-1).replayState, undefined);
  assert.equal(audit.accountedInAssistant, false);
  assert.ok(Object.isFrozen(request));
});

test('tool-call responses, errors and truncations pass through untouched', async () => {
  const llm = { stream() { throw new Error('must not call reviewer'); } };
  for (const kind of ['tool-calls', 'error', 'max-tokens']) {
    const chunks = [...original.slice(0, -1), { type: 'finish', reason: { kind } }];
    assert.deepEqual(await Array.fromAsync(reviewFinalStream(options(), stream(chunks), state([]), llm, limits)), chunks);
  }
});

test('failed review does not discard the usable primary answer', async () => {
  const reviewState = state();
  const llm = { async *stream() { yield { type: 'finish', reason: { kind: 'error' } }; } };
  assert.deepEqual(await Array.fromAsync(reviewFinalStream(options(), stream(original), reviewState, llm, limits)), original);
  assert.equal(latestAudit(reviewState.agent, 'reasoning-support/review').status, 'discarded');
});

test('tool-call chunks stream through as soon as a tool call begins', async () => {
  let continued = false;
  const first = { type: 'block-start', index: 0, blockType: 'tool-call' };
  const source = (async function* () { yield first; continued = true; yield { type: 'finish', reason: { kind: 'tool-calls' } }; })();
  const output = reviewFinalStream(options(), source, state([]), { stream() { throw Error('No review'); } }, limits);
  assert.equal((await output.next()).value, first);
  assert.equal(continued, false);
  await output.return();
});

test('vision tool results bypass text-only review without dropping input capability', async () => {
  const request = { ...options(), messages: [{ content: [{ type: 'tool-result', toolCallId: 'image-read', content: [{ type: 'image', attachment: {} }] }] }] };
  const llm = { stream() { throw new Error('Text-only reviewer must not run'); } };
  assert.deepEqual(await Array.fromAsync(reviewFinalStream(request, stream(original), state([]), llm, limits)), original);
});

test('tool evidence excludes hidden reasoning and preserves result error status', () => {
  const messages = [{ content: [{ type: 'reasoning', text: 'PRIVATE' }, { type: 'tool-call', id: 'c', name: 'pwsh' }] }, { content: [{ type: 'tool-result', toolCallId: 'c', isError: true, content: [{ type: 'text', text: 'Test failed' }] }] }];
  assert.deepEqual(toolEvidence(messages), [{ tool: 'pwsh', error: true, excerpt: 'Test failed' }]);
});

test('review combines only the current request advisory, never a stale candidate', () => {
  const events = [
    { type: 'reasoning-support/advice', data: { turn: 2, requestIds: ['old'], status: 'accepted', advisoryAnswer: 'stale' } },
    { type: 'reasoning-support/advice', data: { turn: 2, requestIds: ['new'], status: 'accepted', advisoryAnswer: 'current' } },
  ];
  const agent = { id: 'advisory-test' };
  for (const event of events) recordAudit(agent, event.type, event.data);
  const state = { turn: 2, requestIds: ['new'], agent };
  assert.equal(currentAdvisory(state), 'current');
  state.requestIds = ['other'];
  assert.equal(currentAdvisory(state), undefined);
});

test('new image or opted-out turns cannot be reviewed against a stale prior question', async () => {
  const hooks = new Map();
  const ctx = { llm: {}, on: (event, hook) => hooks.set(event, hook), effect: callback => callback() };
  await apply(ctx, { llmModule: new URL('./test-fixtures/loop-marker.mjs', import.meta.url).href });
  const agent = { id: 'owned', options: {}, session: { deriveMessages: () => [] } };
  const pre = hooks.get('agent/pre-step');
  const ordinary = { id: '1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Compute something.' }] };
  const request = { testLoop: true, sessionId: 'owned', provider: 'deepseek-official', model: 'deepseek-flash' };
  const sentinel = {};
  for (const followup of [
    { ...ordinary, id: '2', content: [{ type: 'image', attachment: {} }] },
    { ...ordinary, id: '3', content: [{ type: 'text', text: '不要额外模型调用。' }] },
  ]) {
    await pre({ agent, messages: [ordinary], signal: new AbortController().signal, turn: 1 }, async () => ({ kind: 'enter', messages: [ordinary] }));
    await pre({ agent, messages: [followup], signal: new AbortController().signal, turn: 2 }, async () => ({ kind: 'enter', messages: [followup] }));
    assert.equal(hooks.get('llm/stream')(request, () => sentinel), sentinel);
  }
});
