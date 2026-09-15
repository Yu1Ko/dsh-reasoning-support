import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, buildInput, getAdvice } from './analysis-pass.mjs';
import { isSupportedModel, effectiveRoute } from './target-model.mjs';
import { latestAudit } from './audit.mjs';

test('official V41 catalog route and explicit V4.1 relay aliases are recognized', () => {
  assert.equal(isSupportedModel('deepseek-official', 'deepseek-flash'), true);
  assert.equal(isSupportedModel('relay', 'codebuddy/deepseek-v4.1-flash'), true);
  assert.equal(isSupportedModel('deepseek-official', 'deepseek-v4-flash'), false);
  assert.equal(isSupportedModel('other', 'deepseek-flash'), false);
  assert.equal(isSupportedModel('other', 'mydeepseek-v41'), false);
});

test('a Web model selection wins over stale creation options', () => {
  const agent = { options: { provider: 'old', model: 'old-model' }, session: { snapshotEvents: () => [
    { type: 'request/header', data: { header: { config: { provider: 'old', model: 'old-model' } } } },
    { type: 'model/selection', data: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } },
  ] } };
  assert.deepEqual(effectiveRoute(agent), { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' });
});

const user = (text = 'Find the constrained optimum.') => ({ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
function fixture(chunks = [{ type: 'block-end', block: { type: 'text', text: 'A checked advisory result.' } }, { type: 'finish', reason: { kind: 'stop' } }], config = {}) {
  const calls = [];
  let hook;
  const ctx = {
    on(event, listener) { assert.equal(event, 'agent/pre-step'); hook = listener; },
    llm: { async *stream(options) { calls.push(options); for (const chunk of chunks) yield chunk; } },
  };
  const agent = { id: 'test-session', options: { provider: 'existing-route', model: 'codebuddy/deepseek-v4.1-flash', reasoningEffort: 'high' }, session: { deriveMessages: () => [], append() { throw new Error('Audit must not append unknown DSH session events'); } } };
  apply(ctx, config);
  const message = user();
  const decision = { kind: 'enter', messages: [message] };
  return { ctx, agent, message, decision, calls, get events() { const data = latestAudit(agent, 'reasoning-support/advice'); return data ? [{ type: 'reasoning-support/advice', data }] : []; }, invoke: (override = {}, next = async () => decision) => hook({ agent, messages: [message], signal: new AbortController().signal, turn: 1, ...override }, next) };
}

test('same route and cancellation are used; native input is retained; one extra call is recorded', async () => {
  const f = fixture();
  const result = await f.invoke();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].provider, 'existing-route');
  assert.equal(f.calls[0].model, f.agent.options.model);
  assert.deepEqual(f.calls[0].tools, []);
  assert.ok(f.calls[0].signal instanceof AbortSignal);
  assert.equal(result.messages.at(-1), f.message);
  assert.equal(result.messages.length, 2);
  assert.equal(f.events[0].data.status, 'accepted');
  assert.equal(f.events[0].data.calls, 1);
  assert.equal(await f.invoke(), f.decision);
  assert.equal(f.calls.length, 1);
});

test('rejections, tool continuations, non-target models and child agents do not trigger analysis', async () => {
  const f = fixture();
  const rejected = { kind: 'reject', reason: 'restricted' };
  assert.equal(await f.invoke({}, async () => rejected), rejected);
  assert.equal(await f.invoke({ messages: [{ ...user(), source: { kind: 'plugin', plugin: 'external' } }] }), f.decision);
  f.agent.options.model = 'some-other-model';
  assert.equal(await f.invoke(), f.decision);
  f.agent.options.model = 'codebuddy/deepseek-v4.1-flash';
  f.agent.options.subagentDepth = 1;
  assert.equal(await f.invoke(), f.decision);
  assert.equal(f.calls.length, 0);
});

test('interrupted or capped answers are never presented as a successful analysis', async () => {
  const f = fixture([{ type: 'block-end', block: { type: 'text', text: 'An unfinished answer' } }, { type: 'finish', reason: { kind: 'max-tokens' } }]);
  const result = await f.invoke();
  assert.equal(f.events[0].data.status, 'discarded');
  assert.doesNotMatch(JSON.stringify(result), /An unfinished answer/);
  assert.match(JSON.stringify(result), /did not produce a complete usable result/);
});

test('cancellation before dispatch makes no provider call', async () => {
  const f = fixture();
  const signal = AbortSignal.abort(new Error('Stopped by user'));
  await assert.rejects(f.invoke({ signal }), /Stopped by user/);
  assert.equal(f.calls.length, 0);
});

test('stream cancellation propagates rather than returning partial advice', async () => {
  const abort = new AbortController();
  const llm = { async *stream() { yield { type: 'block-end', block: { type: 'text', text: 'partial' } }; abort.abort(new Error('Stop')); yield { type: 'finish', reason: { kind: 'stop' } }; } };
  await assert.rejects(getAdvice(llm, { signal: abort.signal }), /Stop/);
});

test('private reasoning and injected catalogs do not leak into analyst history', () => {
  const f = fixture();
  f.agent.session.deriveMessages = () => [
    { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'UNRELATED_CATALOG' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: 'Earlier public answer.' }] },
  ];
  const input = buildInput(f.agent, [f.message]);
  assert.match(input.text, /Earlier public answer/);
  assert.doesNotMatch(input.text, /PRIVATE_REASONING|UNRELATED_CATALOG/);
  assert.equal(buildInput(f.agent, [user('x'.repeat(48001))]).omitted, true);
  assert.equal(buildInput(f.agent, [{ ...user(), content: [{ type: 'image', attachment: {} }] }]).content.some(block => block.type === 'image'), true);
});

test('compaction checkpoints remain available and extra-call opt-outs are respected', () => {
  const f = fixture();
  f.agent.session.deriveMessages = () => [{ role: 'user', source: { kind: 'plugin', plugin: 'compact', compactionId: 'real-checkpoint-contract' }, content: [{ type: 'text', text: '<compacted-summary>Keep invoice id A19.</compacted-summary>' }] }];
  assert.match(buildInput(f.agent, [user('继续处理上一张发票')]).text, /Keep invoice id A19/);
  assert.equal(buildInput(f.agent, [user('不要额外模型调用，直接回答。')]), undefined);
  assert.equal(buildInput(f.agent, [user('不要\n使用额外的辅助模型复核')]), undefined);
  for (const text of ['No extra model calls.', 'Do not make extra model calls.', "Don't use extra API calls.", 'Without additional model calls.']) {
    assert.equal(buildInput(f.agent, [user(text)]), undefined);
  }
});

test('text follow-ups to image context preserve the original multimodal agent path', () => {
  const f = fixture();
  f.agent.session.deriveMessages = () => [{ id: 'earlier', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: {} }] }];
  assert.equal(buildInput(f.agent, [user('What is shown above?')]).content.some(block => block.type === 'image'), true);
});

test('invalid configuration is rejected', () => {
  assert.throws(() => apply({}, { surprise: true }), /Unsupported/);
  assert.throws(() => apply({}, { maxTokens: -1 }), /Invalid/);
});

test('attachment timeout is contained and never cancels the primary agent', async () => {
  const f = fixture(undefined, { timeoutMs: 1000 });
  f.message.content = [{ type: 'file', attachment: { attachmentId: 'slow-file', name: 'brief.txt', bytes: 3 } }];
  f.ctx.attachments = { async *readFileStream(_ref, signal) {
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    yield Buffer.from('abc');
  } };
  const controller = new AbortController();
  // Keep the event loop alive while AbortSignal.timeout's unref'ed timer fires.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const result = await f.invoke({ signal: controller.signal });
    assert.equal(result.kind, 'enter');
    assert.equal(controller.signal.aborted, false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.events[0].data.status, 'failed');
  } finally { clearTimeout(keepAlive); }
});

test('PDF metadata does not release deferred advice; actual bounded previews do', async () => {
  const f = fixture();
  f.message.content = [{ type: 'file', attachment: { attachmentId: 'pdf-source', name: 'brief.pdf', bytes: 200 } }];
  f.ctx.attachments = { async *readFileStream() { throw new Error('Binary parsing belongs to native tools'); } };
  f.ctx.llm.prepareCall = async config => ({ config, inputModalities: ['text', 'image'], stream: f.ctx.llm.stream.bind(f.ctx.llm) });
  const history = [f.message];
  f.agent.session.deriveMessages = () => history;
  await f.invoke();
  assert.equal(f.calls.length, 0);
  history.push({ content: [{ type: 'tool-call', id: 'meta', name: 'pwsh', arguments: '{"command":"Get-Item pdf-source/brief.pdf | Select-Object Length"}' }] },
    { content: [{ type: 'tool-result', toolCallId: 'meta', content: [{ type: 'text', text: 'Length: 200' }] }] });
  const next = async () => ({ kind: 'enter', messages: [] });
  await f.invoke({ messages: [] }, next);
  assert.equal(f.calls.length, 0);
  history.push({ content: [{ type: 'tool-call', id: 'pages', name: 'read_image', arguments: '{"file_path":"pdf-source-page1.png"}' }] },
    { content: [{ type: 'tool-result', toolCallId: 'pages', content: Array.from({ length: 40 }, (_, index) => ({ type: 'image', attachment: { attachmentId: `page-${index}`, mediaType: 'image/png', bytes: 20, width: 10, height: 10 } })) }] });
  await f.invoke({ messages: [] }, next);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].messages[0].content.filter(block => block.type === 'image').length, 16);
  assert.equal(f.events[0].data.imageCount, 16);
  await f.invoke({ messages: [] }, next);
  assert.equal(f.calls.length, 1);
});
