import test from 'node:test';
import assert from 'node:assert/strict';
import { hostLlmModule } from './host-module.mjs';

test('the active Loader owns loop-request identity even beside an older CLI installation', async () => {
  const requests = new WeakSet();
  const host = { isAgentLoopRequest: request => requests.has(request) };
  const request = {};
  requests.add(request);
  const ctx = { baseUrl: 'file:///profile/', loader: { async import(name, base, options) {
    assert.equal(name, '@deepseek-ai/dsh-llm');
    assert.equal(base, ctx.baseUrl);
    assert.deepEqual(options, {});
    return host;
  } } };
  assert.equal(await hostLlmModule(ctx), host);
  assert.equal((await hostLlmModule(ctx)).isAgentLoopRequest(request), true);
});

test('an explicit fixture URL wins, and invalid overrides fail instead of falling back', async () => {
  const ctx = { loader: { import() { throw new Error('must not use host'); } } };
  const module = await hostLlmModule(ctx, new URL('./test-fixtures/loop-marker.mjs', import.meta.url).href);
  assert.equal(typeof module.isAgentLoopRequest, 'function');
  await assert.rejects(hostLlmModule(ctx, 'https://invalid.example/module.js'), /module URL/);
});
