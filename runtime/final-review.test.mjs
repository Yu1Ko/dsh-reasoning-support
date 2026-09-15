import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, reviewFinalStream, currentAdvisory } from './final-review.mjs';
import { newReviewState, consumeCompletion } from './completion-controller.mjs';
import { buildInput, textBlock } from './request-context.mjs';
import { latestAudit, recordAudit } from './audit.mjs';

const original = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'Wrong draft.' },
  { type: 'block-end', index: 0, block: textBlock('Wrong draft.') },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 35, cacheReadTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' }, replayState: { invalidAfterRewrite: true } },
];
const stream = async function* (values) { yield* values; };
const limits = { timeoutMs: 1000, maxTokens: 1024, maxRepairRounds: 2, maxRepairTimeMs: 300000, maxExtraTokens: 200000 };
const image = id => ({ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: 20, width: 10, height: 10 } });
const pass = answer => ({ status: 'pass', answer, issues: [], failureResolutions: [], materials: [] });
const needs = (status = 'needs_fix') => ({ status, answer: 'Work remains.', issues: [{ requirement: 'The requested behavior must be present.', observation: 'A required case is missing.', evidenceIds: ['tool:c1'], action: 'Inspect and repair the missing case.', verification: 'Run the case again.' }] });
const toolHistory = () => [{ content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"output.txt"}' }] },
  { content: [{ type: 'tool-result', toolCallId: 'c1', content: [textBlock('Actual draft artifact')] }] }];
function fixture(prompt = 'Find the answer.', extra = []) {
  const user = { id: 'u1', role: 'user', source: { kind: 'user' }, content: [textBlock(prompt)] };
  const history = [user, ...extra], queued = [];
  const agent = { id: 'test-review', options: { provider: 'route', model: 'codebuddy/deepseek-v4.1-flash' },
    session: { deriveMessages: () => history, append() { throw new Error('Do not append private audit events'); } },
    inbox: { nextStep: [], nextTurn: [] }, steer: message => queued.push(message) };
  const state = newReviewState(agent, buildInput(agent, [user]), 1);
  const options = Object.freeze({ ...agent.options, sessionId: agent.id, messages: history, signal: new AbortController().signal });
  return { user, history, agent, state, options, queued };
}
function model(value = pass('A corrected answer.'), inputModalities = ['text', 'image']) {
  const calls = [];
  return { calls, async prepareCall(config) {
    return { config: Object.freeze({ ...config }), inputModalities, async *stream(options) {
      calls.push(options);
      const result = typeof value === 'function' ? await value(options) : value;
      if (result !== undefined) yield { type: 'block-end', index: 0, block: textBlock(JSON.stringify(result)) };
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } };
      yield { type: 'finish', reason: { kind: result ? 'stop' : 'error' } };
    } };
  }, stream() { throw new Error('Prepared dispatch must be used'); } };
}
const run = (f, llm, chunks = original, overrides = {}) => Array.fromAsync(reviewFinalStream(f.options, stream(chunks), f.state, llm, { ...limits, ...overrides }));
const answer = chunks => chunks.filter(c => c.type === 'block-end' && c.block.type === 'text').map(c => c.block.text).join('\n');

test('final replacement preserves primary context accounting and separately records auxiliary usage', async () => {
  const f = fixture(), llm = model();
  const result = await run(f, llm);
  const audit = latestAudit(f.agent, 'reasoning-support/review');
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(llm.calls[0].tools, []);
  assert.equal(answer(result), 'A corrected answer.');
  assert.equal(result.find(c => c.type === 'usage').usage.totalTokens, 35);
  assert.equal(result.find(c => c.type === 'usage').usage.inputTokens, 10);
  assert.equal(audit.usage.totalTokens, 10);
  assert.equal(result.at(-1).replayState, undefined);
  assert.equal(audit.accountedInAssistant, false);
  assert.equal(audit.decision.status, 'pass');
  assert.ok(Object.isFrozen(f.options));
});

test('tool-call responses, errors and truncations pass through untouched', async () => {
  for (const kind of ['tool-calls', 'error', 'max-tokens']) {
    const f = fixture(), llm = model();
    const chunks = [...original.slice(0, -1), { type: 'finish', reason: { kind } }];
    assert.deepEqual(await run(f, llm, chunks), chunks);
    assert.equal(llm.calls.length, 0);
  }
});

test('failed optional review retains a usable self-contained primary answer', async () => {
  const f = fixture(), llm = model(() => undefined);
  assert.deepEqual(await run(f, llm), original);
  assert.equal(latestAudit(f.agent, 'reasoning-support/review').status, 'failed');
});

test('tool-call chunks stream through immediately without waiting for final acceptance', async () => {
  const f = fixture();
  let continued = false;
  const first = { type: 'block-start', index: 0, blockType: 'tool-call' };
  const source = (async function* () { yield first; continued = true; yield { type: 'finish', reason: { kind: 'tool-calls' } }; })();
  const output = reviewFinalStream(f.options, source, f.state, model(), limits);
  assert.equal((await output.next()).value, first);
  assert.equal(continued, false);
  await output.return();
});

test('original reference and nested tool preview both reach the prepared visual reviewer', async () => {
  const f = fixture('Describe how the output compares to the reference.', toolHistory());
  f.user.content.push(image('original-reference'));
  f.history.at(-1).content[0].content.push(image('generated-preview'));
  f.state.input = buildInput(f.agent, [f.user]);
  const llm = model(), result = await run(f, llm);
  const content = llm.calls[0].messages[0].content;
  assert.deepEqual(content.filter(b => b.type === 'image').map(b => b.attachment.attachmentId), ['original-reference', 'generated-preview']);
  assert.match(content.filter(b => b.type === 'text').map(b => b.text).join('\n'), /tool-produced image, not the original/);
  assert.equal(answer(result), 'A corrected answer.');
  assert.equal(latestAudit(f.agent, 'reasoning-support/review').imageCount, 2);
});

test('a text-only provider declaration does not silently turn vision into a successful text review', async () => {
  const f = fixture('Build from this reference.');
  f.user.content.push(image('reference'));
  f.state.input = buildInput(f.agent, [f.user]);
  const llm = model(pass('Would be misleading'), ['text']);
  assert.equal(answer(await run(f, llm)), '');
  assert.equal(llm.calls.length, 0);
  assert.equal(f.state.pending.action.kind, 'report');
  assert.equal(latestAudit(f.agent, 'reasoning-support/review').errorCode, 'image-route-not-enabled');
});

test('only the current request advisory can enter final acceptance', () => {
  const f = fixture();
  recordAudit(f.agent, 'reasoning-support/advice', { turn: 1, requestIds: ['old'], status: 'accepted', advisoryAnswer: 'stale' });
  assert.equal(currentAdvisory(f.state), undefined);
  recordAudit(f.agent, 'reasoning-support/advice', { turn: 1, requestIds: ['u1'], status: 'accepted', advisoryAnswer: 'current' });
  assert.equal(currentAdvisory(f.state), 'current');
});

test('a repair decision withholds completion, resumes the same agent, then verifies fresh results', async () => {
  const f = fixture('Build and verify output.txt.', toolHistory());
  const llm = model(() => llm.calls.length === 1 ? needs() : pass('The repaired artifact passed.'));
  assert.doesNotMatch(answer(await run(f, llm)), /Wrong draft/);
  await consumeCompletion(f.state, 1, f.options.signal, limits);
  assert.equal(f.queued.length, 1);
  f.history.push({ content: [{ type: 'tool-call', id: 'verify2', name: 'read', arguments: '{"file_path":"output.txt"}' }] },
    { content: [{ type: 'tool-result', toolCallId: 'verify2', content: [textBlock('The missing behavior is now present and verified.')] }] });
  assert.equal(answer(await run(f, llm)), 'The repaired artifact passed.');
  await consumeCompletion(f.state, 1, f.options.signal, limits);
  assert.equal(f.queued.length, 1);
  assert.equal(llm.calls.length, 2);
  assert.equal(f.state.repairRounds, 1);
});

test('missing evidence requests inspection, not an ungrounded implementation change', async () => {
  const f = fixture('Build and verify the output.', toolHistory());
  await run(f, model(needs('needs_evidence')));
  await consumeCompletion(f.state, 1, f.options.signal, limits);
  assert.match(f.queued[0].content[0].text, /additional evidence before deciding whether any code needs changing/);
});

test('repeated drafts without new evidence stop without purchasing another review', async () => {
  const f = fixture('Build and verify output.txt.', toolHistory()), llm = model(needs());
  await run(f, llm);
  await consumeCompletion(f.state, 1, f.options.signal, limits);
  await run(f, llm);
  assert.equal(llm.calls.length, 1);
  assert.equal(f.state.pending.action.reason, 'no-new-evidence-or-artifact');
  await consumeCompletion(f.state, 1, f.options.signal, limits);
  assert.equal(f.state.reporting, true);
  assert.deepEqual(await run(f, llm), original);
  assert.equal(llm.calls.length, 1);
});

test('structured reviewer JSON is unwrapped without corrupting user-requested strict JSON', async () => {
  const f = fixture('Return only JSON with answer 42.');
  const result = await run(f, model(pass('{"answer":42}')));
  assert.deepEqual(JSON.parse(answer(result)), { answer: 42 });
  assert.doesNotMatch(answer(result), /status|issues/);
});

test('strict-output engineering tasks receive no intermediate prose when a correction is pending', async () => {
  const f = fixture('Build output.txt, then return only JSON.', toolHistory());
  assert.equal(answer(await run(f, model(needs()))), '');
  assert.equal(f.state.pending.action.kind, 'continue');
});

test('failed engineering review requests a factual unverified report instead of false acceptance', async () => {
  const f = fixture('Build the artifact.', toolHistory());
  assert.equal(answer(await run(f, model(() => undefined))), '');
  await consumeCompletion(f.state, 1, f.options.signal, limits);
  assert.match(f.queued[0].content[0].text, /Do not claim acceptance passed/);
});

test('a newer user request during review prevents stale output and repair steering', async () => {
  const f = fixture('Build the artifact.', toolHistory());
  const llm = model(() => { f.agent.inbox.nextStep.push({ id: 'u2', source: { kind: 'user' } }); return needs(); });
  assert.equal(answer(await run(f, llm)), '');
  assert.equal(f.state.pending, undefined);
  assert.equal(f.queued.length, 0);
});

test('cancelled review propagates user cancellation rather than completing a partial reply', async () => {
  const f = fixture(), abort = new AbortController();
  f.options = { ...f.options, signal: abort.signal };
  const llm = model(() => { abort.abort(new Error('user cancelled')); return pass('partial'); });
  await assert.rejects(run(f, llm), /user cancelled/);
  assert.equal(latestAudit(f.agent, 'reasoning-support/review').status, 'cancelled');
});

async function pluginFixture(checkpoint = false, config = {}) {
  const hooks = new Map(), registered = [], f = fixture('Build an artifact.', toolHistory()), llm = model();
  const ctx = { llm, tools: { register(tool) { registered.push(tool); return () => {}; } },
    on: (event, hook) => hooks.set(event, hook), effect: callback => callback() };
  await apply(ctx, { llmModule: new URL('./test-fixtures/loop-marker.mjs', import.meta.url).href, checkpoint, ...config });
  await hooks.get('agent/pre-step')({ agent: f.agent, messages: [f.user], signal: f.options.signal, turn: 1 }, async () => ({ kind: 'enter', messages: [f.user] }));
  return { hooks, registered, f, llm };
}

test('new images establish a fresh request and explicit opt-outs clear old review state', async () => {
  const { hooks, f } = await pluginFixture();
  const second = { ...f.user, id: 'u2', content: [image('new-picture')] };
  await hooks.get('agent/pre-step')({ agent: f.agent, messages: [second], signal: f.options.signal, turn: 2 }, async () => ({ kind: 'enter', messages: [second] }));
  const third = { ...f.user, id: 'u3', content: [textBlock('No extra model calls.')] };
  await hooks.get('agent/pre-step')({ agent: f.agent, messages: [third], signal: f.options.signal, turn: 3 }, async () => ({ kind: 'enter', messages: [third] }));
  const sentinel = {};
  assert.equal(hooks.get('llm/stream')({ ...f.options, testLoop: true }, () => sentinel), sentinel);
});

test('checkpoint is absent by default and can spend at most one auxiliary call when enabled', async () => {
  assert.equal((await pluginFixture()).registered.length, 0);
  const { registered, f, llm } = await pluginFixture(true);
  assert.equal(registered.length, 1);
  const exec = { agent: f.agent, signal: f.options.signal };
  const first = await registered[0].execute({ stage: 'First working artifact' }, exec);
  const second = await registered[0].execute({ stage: 'The same artifact again' }, exec);
  assert.equal(first.calls, 1);
  assert.equal(second.calls, 0);
  assert.equal(second.status, 'already-used');
  assert.equal(llm.calls.length, 1);
  assert.equal(latestAudit(f.agent, 'reasoning-support/checkpoint').calls, 1);
});

test('invalid review budgets and checkpoint settings are rejected', async () => {
  const llmModule = new URL('./test-fixtures/loop-marker.mjs', import.meta.url).href;
  for (const config of [{ maxRepairRounds: 5 }, { maxRepairTimeMs: -1 }, { checkpoint: 'yes' }]) {
    await assert.rejects(apply({}, { llmModule, ...config }), /Invalid|boolean/);
  }
});

test('checkpoint includes already-consumed advisory usage in its budget', async () => {
  const { registered, f, llm } = await pluginFixture(true, { maxExtraTokens: 1024 });
  recordAudit(f.agent, 'reasoning-support/advice', { turn: 1, requestIds: ['u1'], status: 'accepted', usage: { totalTokens: 2000 } });
  const result = await registered[0].execute({ stage: 'First working file' }, { agent: f.agent, signal: f.options.signal });
  assert.equal(result.status, 'unverified');
  assert.equal(result.calls, 0);
  assert.equal(llm.calls.length, 0);
});

test('a later recurring failure cannot reuse a previously passing cached review', async () => {
  const f = fixture('Build and test the artifact.'), llm = model(pass('Everything passed.'));
  const check = (id, error) => [{ content: [{ type: 'tool-call', id, name: 'pwsh', arguments: '{"command":"npm test"}' }] },
    { content: [{ type: 'tool-result', toolCallId: id, isError: error, content: [textBlock(error ? 'FAILED' : 'PASSED')] }] }];
  f.history.push(...check('failed1', true), ...check('passed1', false));
  assert.equal(answer(await run(f, llm)), 'Everything passed.');
  await consumeCompletion(f.state, 1, f.options.signal, limits);
  f.history.push(...check('failed2', true));
  assert.notEqual(answer(await run(f, llm)), 'Everything passed.');
  assert.equal(llm.calls.length, 2);
  assert.equal(f.state.pending.decision.status, 'needs_evidence');
});
