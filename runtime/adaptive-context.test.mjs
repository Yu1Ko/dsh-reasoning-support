import test from 'node:test';
import assert from 'node:assert/strict';
import { shapePrompt, compactSkillCatalog, restoredTools, searchEntries, apply } from './adaptive-context.mjs';

test('persona, project facts, plan policy, third-party guidance and schemas are preserved', () => {
  const assembly = {
    sections: [
      { name: 'harness:identity', text: 'An identity contribution must survive.' },
      { name: 'deployment:persona-prefix', text: 'Roleplay rules' },
      { name: 'tool:read', text: 'Use offset for long files.' },
      { name: 'plan:policy', text: 'Do not mutate files.' },
      { name: 'third-party:role', text: 'Additional character details' },
    ],
    contexts: [{ name: 'approval', text: 'Ask before external writes' }],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    variables: { cwd: '/scratch' },
  };
  const before = structuredClone(assembly), output = shapePrompt(assembly);
  assert.deepEqual(assembly, before);
  assert.deepEqual(output.sections.filter(section => section.name !== 'reasoning-support:reasoning'), [assembly.sections[0], assembly.sections[1], assembly.sections[3], assembly.sections[4]]);
  assert.match(output.tools[0].description, /Use offset/);
  assert.equal(output.tools[0].parameters, assembly.tools[0].parameters);
  assert.equal(output.contexts, assembly.contexts);
});

test('only automatic skill catalogs are compacted, including across compaction', () => {
  for (const kind of ['user', 'agent-instructions', 'skill-invocation', 'plugin', 'goal']) {
    const message = { id: kind, source: { kind }, content: [{ type: 'text', text: 'Keep all these instructions.' }] };
    assert.equal(compactSkillCatalog(message), message);
  }
  const source = { kind: 'skill-catalog', entries: [{ name: 'a', description: 'A' }] };
  const original = { id: 'catalog', source, content: [{ type: 'text', text: 'Long catalog' }] };
  const output = compactSkillCatalog(original);
  assert.equal(output.id, original.id);
  assert.equal(output.source, source);
  assert.match(output.content[0].text, /skill_search/);
  assert.equal(original.content[0].text, 'Long catalog');
});

test('tool exposure restores only successful discovery results and ignores unrelated text', () => {
  const result = (call, names, isError = false) => ({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: call, isError, content: [{ type: 'text', text: JSON.stringify({ reasoningSupportDiscovery: 1, enabledTools: names }) }] }] } } });
  const events = [
    result('unrelated', ['evil']),
    { type: 'tool/call', data: { name: 'tool_search', callId: 'ours' } },
    result('ours', ['scene_open', 'scene_read']),
    result('ours', ['bad'], true),
    { type: 'compaction/end', data: {} },
  ];
  assert.deepEqual(restoredTools(events), ['scene_open', 'scene_read']);
});

test('discovery handles exact names, task keywords and no matches deterministically', () => {
  const entries = [{ name: 'scene_read', description: 'Inspect Godot scene' }, { name: 'file_read', description: 'Read a file' }];
  assert.equal(searchEntries(entries, 'scene_read')[0].name, 'scene_read');
  assert.equal(searchEntries(entries, 'scene_read').length, 1);
  assert.equal(searchEntries(entries, 'Godot')[0].name, 'scene_read');
  assert.deepEqual(searchEntries(entries, 'unavailable weather'), []);
});

test('function words and partial names cannot crowd out a relevant capability', () => {
  const entries = ['ask_user_question', 'create_goal', 'job_kill', 'update_goal', 'subagent', 'current_settings'].map(name => ({ name, description: 'A helper tool' }));
  entries.push({ name: 'get_current_conditions', description: 'Get current weather' });
  assert.equal(searchEntries(entries, 'a weather tool')[0].name, 'get_current_conditions');
  assert.equal(searchEntries(entries, 'Could you get the current weather?')[0].name, 'get_current_conditions');
});

test('Chinese capability queries work without requiring artificial spaces', () => {
  const entries = [
    { name: 'general-helper', description: '可以使用的一个工具，帮我处理常见任务' },
    { name: 'log-parser', description: '解析日志并统计错误频次' },
    { name: 'godot-docs', description: '核对 Godot 节点 API 文档' },
  ];
  assert.equal(searchEntries(entries, '帮我查找能够解析日志的工具')[0].name, 'log-parser');
  assert.equal(searchEntries(entries, '查找核对Godot节点API的技能')[0].name, 'godot-docs');
});

test('first-step discovery, native dispatch, session isolation and refusal preservation', async () => {
  const hooks = new Map(), tools = new Map();
  const ctx = { on: (name, hook) => hooks.set(name, hook), effect: fn => fn(), tools: { register: tool => tools.set(tool.name, tool), get: name => tools.get(name) ?? (name === 'scene_read' ? { name } : undefined) }, skills: { list: async () => [] } };
  apply(ctx);
  const agent = { session: { snapshotEvents: () => [] } }, other = { session: { snapshotEvents: () => [] } };
  const assembly = { sections: [], contexts: [], variables: { cwd: '/tmp' }, tools: [
    { name: 'pwsh' }, ...tools.values(), { name: 'scene_read', description: 'Godot scene inspection' },
  ] };
  const assemble = owner => hooks.get('system-prompt/assemble')(assembly, { agent: owner }, async () => assembly);
  assert.deepEqual((await assemble(agent)).tools.map(tool => tool.name), ['pwsh', 'tool_search', 'skill_search']);
  await tools.get('tool_search').execute({ query: 'Godot' }, { agent, signal: new AbortController().signal });
  assert.ok((await assemble(agent)).tools.some(tool => tool.name === 'scene_read'));
  assert.ok(!(await assemble(other)).tools.some(tool => tool.name === 'scene_read'));
  const rejection = { kind: 'reject', reason: 'Permission denied' };
  assert.equal(await hooks.get('agent/pre-step')({ messages: [] }, async () => rejection), rejection);
});

test('restricted scopes retain the full skill catalog when discovery is unavailable', async () => {
  const hooks = new Map(), registered = new Map();
  apply({ on: (name, hook) => hooks.set(name, hook), effect: fn => fn(), tools: { register: tool => registered.set(tool.name, tool), get: name => registered.get(name) }, skills: {} });
  const agent = { session: { snapshotEvents: () => [] } };
  const assembly = { sections: [], contexts: [], variables: {}, tools: [{ name: 'read' }, { name: 'skill' }] };
  await hooks.get('system-prompt/assemble')(assembly, { agent }, async () => assembly);
  const catalog = { id: 'catalog', source: { kind: 'skill-catalog', entries: [{ name: 'test-skill' }] }, content: [{ type: 'text', text: 'Full skill descriptions' }] };
  const decision = await hooks.get('agent/pre-step')({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [catalog] }));
  assert.equal(decision.messages[0], catalog);
});
