import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readAuditRecords } from '../runtime/audit.mjs';
import { makePng, makePdf } from './media-fixtures.mjs';

export const name = 'reasoning-support-native-validation';
export const inject = ['agents', 'agentPresets', 'sessions', 'llm', 'attachments'];
const textBlock = text => ({ type: 'text', text });
const png = makePng();
const passed = answer => ({ status: 'pass', answer, issues: [], failureResolutions: [], materials: [] });
const gap = (status, id) => ({ status, answer: 'The requested artifact still needs verification or repair.', issues: [{ requirement: 'output.txt contains first=1 and second=2, and is read back.',
  observation: status === 'needs_fix' ? 'The second required line is absent.' : 'There is no read-back evidence.', evidenceIds: [id],
  action: status === 'needs_fix' ? 'Add the missing second line, then read the file back.' : 'Read the file back without rewriting it.', verification: 'Inspect output.txt and confirm both lines.' }] });

function* response(value, tool) {
  if (tool) {
    const id = randomUUID(), args = JSON.stringify(tool.args);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name: tool.name, argumentsDelta: args };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool.name, arguments: args } };
  } else {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: value };
    yield { type: 'block-end', index: 0, block: textBlock(value) };
  }
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
  yield { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } };
}

export async function apply(ctx, config) {
  const exit = ctx.get('appExit');
  const { LlmAdapter } = await import(config.llmModule);
  const scenarios = new Map(), wire = [];
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text', 'image'], context: { contextWindow: 131072 } }; }
    async *stream(options) {
      const scenario = scenarios.get(String(options.sessionId));
      assert.ok(scenario, 'Every validation request belongs to a known test session');
      const blocks = options.messages.flatMap(message => message.content);
      const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const images = blocks.filter(block => block.type === 'image');
      const system = options.system ?? '';
      const phase = system.startsWith('You are a careful problem solver') ? 'advice' : system.startsWith('You are the correctness and artifact-acceptance reviewer') ? 'review' : 'main';
      const checkpoint = system.includes('This is an intermediate checkpoint.');
      for (const image of images) assert.ok((await ctx.attachments.readImage(image.attachment, options.signal)).data.byteLength > 0);
      wire.push({ case: scenario.name, phase, checkpoint, imageCount: images.length });
      if (phase !== 'main' && scenario.name === 'text-attachment') assert.match(text, /ATTACHMENT-CODE-7391/);
      if (phase !== 'main' && scenario.name === 'pdf-attachment') assert.match(text, /MATERIAL-CODE-7391/);
      if (phase !== 'main' && ['image', 'image-followup'].includes(scenario.name)) assert.ok(images.length >= 1, 'Auxiliary adapter receives actual image references');
      if (phase === 'advice') { yield* response('Preserve the original constraints and verify the actual artifact.'); return; }
      if (phase === 'review') {
        const evidence = blocks.filter(block => block.type === 'text' && block.text.startsWith('[observed_tool_result]\n')).map(block => JSON.parse(block.text.slice('[observed_tool_result]\n'.length)));
        const read = evidence.filter(record => record.tool === 'read').at(-1);
        let review = passed(scenario.name === 'strict-json' ? '{"answer":42}' : 'Verified result.');
        if (['repair', 'evidence'].includes(scenario.name) && !checkpoint) {
          review = !read ? gap('needs_evidence', evidence.at(-1).id) : !read.excerpt.includes('second=2') ? gap('needs_fix', read.id) : passed('{"complete":true}');
        }
        yield* response(JSON.stringify(review)); return;
      }
      const step = scenario.step++;
      const output = join(scenario.cwd, 'output.txt');
      const write = content => ({ name: 'write', args: { file_path: output, content } });
      const read = { name: 'read', args: { file_path: output } };
      if (scenario.name === 'image' && step === 0) { yield* response('', { name: 'read_image', args: { file_path: join(scenario.cwd, 'preview.png') } }); return; }
      if (scenario.name === 'pdf-attachment') {
        const quote = value => "'" + value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'";
        const python = process.env.DSH_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
        const script = 'import sys; from pathlib import Path; from pypdf import PdfReader; Path(sys.argv[2]).write_text("\\n".join(page.extract_text() or "" for page in PdfReader(sys.argv[1]).pages), encoding="utf-8")';
        const tool = [{ name: process.platform === 'win32' ? 'pwsh' : 'bash', args: { command: `${process.platform === 'win32' ? '& ' : ''}${quote(python)} -c ${quote(script)} ${quote(scenario.pdfPath)} ${quote(scenario.pdfText)}`, description: 'Parse the attached PDF into readable text', workdir: scenario.cwd } },
          { name: 'read', args: { file_path: scenario.pdfText } }][step];
        yield* response('The PDF content has been read.', tool); return;
      }
      if (scenario.name === 'repair') {
        const tool = [write('first=1\n'), read, undefined, write('first=1\nsecond=2\n'), read][step];
        yield* response('{"complete":true}', tool); return;
      }
      if (scenario.name === 'evidence') {
        const tool = [write('first=1\nsecond=2\n'), undefined, read][step];
        yield* response('{"complete":true}', tool); return;
      }
      if (scenario.name === 'checkpoint') {
        const tool = [write('first=1\nsecond=2\n'), read, { name: 'reasoning_support_checkpoint', args: { stage: 'The first file exists and has been read back.' } },
          { name: 'reasoning_support_checkpoint', args: { stage: 'Repeat the same checkpoint; no extra model call should occur.' } }][step];
        yield* response('Complete.', tool); return;
      }
      yield* response(scenario.name === 'strict-json' ? '{"answer":41}' : scenario.name === 'opt-out' ? '{"answer":42}' : 'The primary result.');
    }
  }
  ctx.llm.registerAdapter(['local-validation'], new FixtureAdapter());
  (async () => {
    await ctx.get('loader').await();
    const results = [];
    const names = ['strict-json', 'repair', 'evidence', 'checkpoint', 'image', 'text-attachment', 'pdf-attachment', 'opt-out'];
    for (const name of names) {
      const sessionId = 'validation-' + randomUUID(), cwd = join(config.home, 'workspace', name);
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, 'preview.png'), makePng(64, 64, () => [20, 50, 220]));
      const scenario = { name, step: 0, cwd };
      scenarios.set(sessionId, scenario);
      const handle = await ctx.agents.create({ sessionId, meta: { cwd, agentPreset: 'reasoning-support' },
        agentOptions: { provider: 'local-validation', model: 'deepseek-v4.1-test', maxTokens: 4096 },
        setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'reasoning-support'); } });
      const agent = handle.agent;
      try {
        await agent.whenIdle();
        const prompt = name === 'opt-out' ? 'No extra model calls. Return only JSON with answer 42.' :
          name === 'strict-json' ? 'Do not use tools. Return only JSON with answer equal to 17 + 25.' :
          ['repair', 'evidence'].includes(name) ? 'Create output.txt with first=1 and second=2 on separate lines, read it back, then return only JSON. These workspace file operations are authorized.' :
          name === 'checkpoint' ? 'Create and verify output.txt. Use the optional checkpoint after the first working file. Workspace file operations are authorized.' :
          name === 'image' ? 'Describe the attached image.' : 'Read the attached requirements text and report its code.';
        const content = [textBlock(prompt)];
        if (name === 'image') content.push({ type: 'image', attachment: await ctx.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'reference.png' }) });
        if (name === 'text-attachment') content.push({ type: 'file', attachment: await ctx.attachments.saveFile({ data: Buffer.from('Requirements: ATTACHMENT-CODE-7391'), name: 'requirements.txt' }) });
        if (name === 'pdf-attachment') {
          const attachment = await ctx.attachments.saveFile({ data: makePdf(), name: 'requirements.pdf' });
          content.push({ type: 'file', attachment });
          scenario.pdfPath = await ctx.attachments.fileHostPath(attachment);
          scenario.pdfText = join(cwd, `${String(attachment.attachmentId).replace(/^sha256:/, '')}-parsed.txt`);
        }
        const timer = setTimeout(() => agent.cancel({ kind: 'hook', reason: 'Native validation deadline' }), 20000);
        try {
          agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content });
          await agent.whenIdle();
        } finally { clearTimeout(timer); }
        let events = agent.session.snapshotEvents();
        const endReason = events.filter(e => e.type === 'turn/end').at(-1)?.data.reason;
        assert.equal(endReason?.kind, 'completed', JSON.stringify(endReason));
        const audit = readAuditRecords(join(config.home, 'storages/reasoning-support-audit'), sessionId);
        assert.ok(audit.filter(record => record.calls > 0).every(record => record.status === 'accepted'), `${name}: all dispatched auxiliaries must complete`);
        assert.ok(!audit.some(record => record.status === 'report-unverified'), `${name}: unexpected unverified-report fallback`);
        const auxiliary = audit.reduce((sum, record) => sum + record.calls, 0);
        const expected = name === 'opt-out' ? 0 : ['repair', 'evidence', 'checkpoint'].includes(name) ? 3 : 2;
        assert.equal(auxiliary, expected, `${name}: auxiliary call count`);
        assert.equal(events.filter(e => e.type === 'turn/start').length, 1, 'Repairs stay within the original turn');
        const answer = events.filter(e => e.type === 'assistant/message').at(-1)?.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        if (name === 'strict-json' || name === 'opt-out') assert.deepEqual(JSON.parse(answer), { answer: 42 });
        if (['repair', 'evidence', 'checkpoint'].includes(name)) assert.equal(readFileSync(join(cwd, 'output.txt'), 'utf8'), 'first=1\nsecond=2\n');
        if (name === 'pdf-attachment') assert.match(readFileSync(scenario.pdfText, 'utf8'), /MATERIAL-CODE-7391/);
        const tools = events.filter(e => e.type === 'tool/call').map(e => e.data.name);
        if (name === 'evidence') assert.equal(tools.filter(tool => tool === 'write').length, 1, 'Evidence request does not cause an unnecessary rewrite');
        if (name === 'image') {
          scenario.name = 'image-followup';
          agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [textBlock('Describe that same image again.')] });
          await agent.whenIdle();
          events = agent.session.snapshotEvents();
          assert.equal(events.filter(e => e.type === 'turn/end').at(-1)?.data.reason.kind, 'completed');
          assert.equal(readAuditRecords(join(config.home, 'storages/reasoning-support-audit'), sessionId).reduce((sum, record) => sum + record.calls, 0), 4);
        }
        results.push({ case: name, passed: true, auxiliaryCalls: auxiliary, mainCalls: wire.filter(w => w.case === name && w.phase === 'main').length, tools, sameTurn: true });
      } finally { await handle.dispose(); }
    }
    const result = { passed: true, deterministicProvider: true, actualDshLoopAndFileTools: true, cases: results, adapterObservations: wire.filter(w => w.phase !== 'main') };
    writeFileSync(join(config.home, 'native-validation.json'), JSON.stringify(result, null, 2));
    exit(0);
  })().catch(error => {
    writeFileSync(join(config.home, 'native-validation.json'), JSON.stringify({ passed: false, error: error.message, stack: error.stack, adapterObservations: wire }, null, 2));
    exit(1);
  });
}
