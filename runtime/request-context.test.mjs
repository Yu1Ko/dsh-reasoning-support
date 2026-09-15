import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInput, prepareMaterials, toolEvidence, progressFingerprint, observedMessages } from './request-context.mjs';

const image = id => ({ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: 20, width: 10, height: 10 } });
const file = (name, bytes, id = 'file-1') => ({ type: 'file', attachment: { attachmentId: id, name, bytes } });
const user = content => ({ id: 'u1', role: 'user', source: { kind: 'user' }, content });
const agent = (history = []) => ({ session: { deriveMessages: () => history } });
const text = value => ({ type: 'text', text: value });
const visibleText = blocks => blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');

test('current and historical images keep their order and original references', () => {
  const before = image('old'), current = image('new');
  const message = user([text('Compare this:'), current, text('to the earlier picture.')]);
  const history = [{ ...user([text('Original reference'), before]), id: 'old-user' }];
  const input = buildInput(agent(history), [message]);
  assert.deepEqual(input.content.filter(b => b.type === 'image'), [before, current]);
  assert.equal(input.content.find(b => b.type === 'image').attachment, before.attachment);
  assert.deepEqual(message.content, [text('Compare this:'), current, text('to the earlier picture.')]);
  assert.match(input.text, /current_user_request|prior_conversation/);
});

test('large input is visibly excerpted while private reasoning and catalogs stay out', () => {
  const history = [{ role: 'assistant', content: [{ type: 'reasoning', text: 'SECRET_THOUGHT' }, text('Earlier answer')] },
    { role: 'user', source: { kind: 'skill-catalog' }, content: [text('CATALOG_SENTINEL')] }];
  const input = buildInput(agent(history), [user([text('START-' + 'x'.repeat(60000) + '-END')])]);
  assert.match(input.text, /START-/);
  assert.match(input.text, /-END/);
  assert.match(input.text, /omitted/);
  assert.doesNotMatch(input.text, /SECRET_THOUGHT|CATALOG_SENTINEL/);
  assert.ok(input.text.length < 49000);
  assert.equal(input.omitted, true);
});

test('UTF-8 attachments are completely consumed and verified before using any text', async () => {
  const bytes = Buffer.from('附件正文：最后一行是 7391。');
  let completed = false, reads = 0;
  const attachments = { async *readFileStream() { reads++; yield bytes.subarray(0, 4); yield bytes.subarray(4); completed = true; } };
  const input = buildInput(agent(), [user([file('brief.txt', bytes.length)])]);
  const cache = new Map();
  const material = await prepareMaterials(input.content, attachments, { cache, signal: new AbortController().signal });
  assert.equal(completed, true);
  assert.match(visibleText(material.content), /最后一行是 7391/);
  assert.equal(material.files[0].status, 'read');
  await prepareMaterials(input.content, attachments, { cache });
  assert.equal(reads, 1);
});

test('a corrupt attachment never leaks unverified partial text', async () => {
  const attachments = { async *readFileStream() { yield Buffer.from('UNVERIFIED_SECRET'); throw Object.assign(new Error('mismatch'), { code: 'ATTACHMENT_CORRUPT' }); } };
  const input = buildInput(agent(), [user([file('brief.txt', 17)])]);
  const result = await prepareMaterials(input.content, attachments);
  assert.equal(result.files[0].status, 'unavailable');
  assert.doesNotMatch(visibleText(result.content), /UNVERIFIED_SECRET/);
  assert.match(visibleText(result.content), /ATTACHMENT_CORRUPT/);
});

test('large and binary attachments are explicit read tasks, not invented contents', async () => {
  let read = false;
  const attachments = { async *readFileStream() { read = true; } };
  const blocks = [file('model.blend', 200), file('large.txt', 3_000_000, 'large')];
  const result = await prepareMaterials(blocks, attachments);
  assert.equal(read, false);
  assert.deepEqual(result.files.map(f => f.status), ['needs_tool', 'needs_tool']);
  assert.match(visibleText(result.content), /not.*read|not.*parsed/);
});

test('binary reading evidence must reference the attachment, with actual content or preview', async () => {
  const input = [file('drawing.pdf', 200, 'pdf-id')];
  const evidence = toolEvidence([
    { content: [{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'parse attachments/pdf-id/drawing.pdf' }) }] },
    { content: [{ type: 'tool-result', toolCallId: 'c1', content: [text('Page 1: height 12 cm.'), image('page1')] }] },
  ]);
  const result = await prepareMaterials(input, {}, { evidence });
  assert.equal(result.files[0].status, 'tool_evidence');
  assert.deepEqual(result.files[0].evidenceIds, ['tool:c1']);
  assert.equal(evidence.content.filter(b => b.type === 'image')[0].attachment.attachmentId, 'page1');
});

test('tool evidence preserves errors, output tails, image provenance and stable progress', () => {
  const history = id => [
    { content: [{ type: 'tool-call', id, name: 'pwsh', arguments: '{"command":"npm test"}' }] },
    { content: [{ type: 'tool-result', toolCallId: id, isError: true, content: [text('BEGIN\n' + '.'.repeat(7000) + '\nFAILED AT END'), image('preview')] }] },
  ];
  const evidence = toolEvidence(history('c1'));
  assert.equal(evidence.records[0].error, true);
  assert.match(evidence.records[0].excerpt, /BEGIN/);
  assert.match(evidence.records[0].excerpt, /FAILED AT END/);
  assert.match(visibleText(evidence.content), /tool:c1/);
  assert.equal(progressFingerprint(toolEvidence(history('c1'))), progressFingerprint(toolEvidence([...history('c1'), ...history('c2')])));
});

test('attachment cancellation propagates and never caches a partial read', async () => {
  const abort = new AbortController(), cache = new Map();
  const attachments = { async *readFileStream() { yield Buffer.from('abc'); abort.abort(new Error('cancelled')); yield Buffer.from('def'); } };
  await assert.rejects(prepareMaterials([file('file.txt', 6)], attachments, { signal: abort.signal, cache }), /cancelled/);
  assert.equal(cache.size, 0);
});

test('conversation-wide auxiliary opt-out persists until an explicit opt-in', () => {
  const disabled = { ...user([text('For the rest of this conversation, do not make extra model calls.')]), id: 'earlier' };
  const ongoing = agent([disabled]);
  assert.equal(buildInput(ongoing, [user([text('Continue.')])]), undefined);
  assert.ok(buildInput(ongoing, [user([text('Re-enable extra model calls. Continue.')])]));
  assert.ok(buildInput(agent([{ ...user([text('No extra model calls for this answer.')]), id: 'earlier' }]), [user([text('Continue with the next task.')])]));
});

test('progress uses the latest outcome of a check, including failure after success', () => {
  const events = (id, error) => [{ content: [{ type: 'tool-call', id, name: 'pwsh', arguments: '{"command":"npm test"}' }] },
    { content: [{ type: 'tool-result', toolCallId: id, isError: error, content: [text(error ? 'FAILED' : 'PASSED')] }] }];
  const firstPass = [...events('f1', true), ...events('p1', false)];
  const regression = [...firstPass, ...events('f2', true)];
  assert.notEqual(progressFingerprint(toolEvidence(firstPass)), progressFingerprint(toolEvidence(regression)));
  assert.equal(progressFingerprint(toolEvidence(firstPass)), progressFingerprint(toolEvidence([...regression, ...events('p2', false)])));
});

test('DSH sha256 attachment IDs associate with safe derived filenames without a colon', async () => {
  const hash = 'a'.repeat(64);
  const evidence = toolEvidence([{ content: [{ type: 'tool-call', id: 'parse-read', name: 'read', arguments: JSON.stringify({ file_path: `${hash}-parsed.txt` }) }] },
    { content: [{ type: 'tool-result', toolCallId: 'parse-read', content: [text('Extracted page contents')] }] }]);
  const result = await prepareMaterials([file('brief.pdf', 100, `sha256:${hash}`)], { readFileStream() { throw Error('not used'); } }, { evidence });
  assert.equal(result.files[0].status, 'tool_evidence');
});

test('native command exit markers retain failures even without tool isError', () => {
  const evidence = toolEvidence([{ content: [{ type: 'tool-call', id: 'test', name: 'pwsh', arguments: '{"command":"npm test"}' }] },
    { content: [{ type: 'tool-result', toolCallId: 'test', content: [text('Tests failed\n[exit code: 1]')] }] }]);
  assert.equal(evidence.records[0].error, true);
  assert.equal(evidence.records[0].exitCode, 1);
});

test('verified shell content readers release attachment preparation but metadata-only commands do not', async () => {
  const hash = 'b'.repeat(64);
  const source = [file('brief.pdf', 100, `sha256:${hash}`)];
  const tools = command => toolEvidence([{ content: [{ type: 'tool-call', id: 'shell', name: 'pwsh', arguments: JSON.stringify({ command }) }] },
    { content: [{ type: 'tool-result', toolCallId: 'shell', content: [text('Page one: the required code is 7391.')] }] }]);
  assert.equal((await prepareMaterials(source, { readFileStream() {} }, { evidence: tools(`Get-Content ${hash}/extracted.txt -Raw`) })).files[0].status, 'tool_evidence');
  assert.equal((await prepareMaterials(source, { readFileStream() {} }, { evidence: tools(`Get-Item ${hash}/brief.pdf | Select-Object Length`) })).files[0].status, 'needs_tool');
});

test('long shell arguments keep source association without expanding the model-facing excerpt', async () => {
  const hash = 'c'.repeat(64);
  const command = '# ' + 'x'.repeat(1200) + `\nGet-Content ${hash}/extracted.txt\n# ` + 'x'.repeat(1200);
  const evidence = toolEvidence([{ content: [{ type: 'tool-call', id: 'shell', name: 'pwsh', arguments: JSON.stringify({ command }) }] },
    { content: [{ type: 'tool-result', toolCallId: 'shell', content: [text('Extracted body')] }] }]);
  assert.ok(evidence.records[0].input.length <= 1600);
  assert.equal((await prepareMaterials([file('brief.pdf', 100, `sha256:${hash}`)], { readFileStream() {} }, { evidence })).files[0].status, 'tool_evidence');
  assert.doesNotMatch(visibleText(evidence.content), /rawInput/);
});

test('native journal evidence survives model-message compaction and excludes earlier requests', () => {
  const task = user([text('Build the artifact.')]);
  const events = [
    { type: 'tool/call', data: { callId: 'previous', name: 'pwsh', arguments: '{}' } },
    { type: 'user/message', data: { message: task } },
    { type: 'tool/call', data: { callId: 'failed-check', name: 'pwsh', arguments: '{"command":"npm test"}' } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'PRIVATE' }] } } },
    { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'failed-check', isError: true, content: [text('Failure before compaction')] }] } } },
  ];
  const agent = { session: { snapshotEvents: () => events, deriveMessages: () => [user([text('Compacted summary')])] } };
  const messages = observedMessages(agent, ['u1']);
  const evidence = toolEvidence(messages, { requestIds: ['u1'] });
  assert.equal(evidence.records.length, 1);
  assert.equal(evidence.records[0].error, true);
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE|previous/);
});

test('a parser that only reports page count and output path does not release analysis before reading', async () => {
  const hash = 'd'.repeat(64);
  const evidence = toolEvidence([{ content: [{ type: 'tool-call', id: 'parse', name: 'pwsh', arguments: JSON.stringify({ command: `python -c "PdfReader('${hash}/brief.pdf').pages[0].extract_text(); print('pages: 1')"` }) }] },
    { content: [{ type: 'tool-result', toolCallId: 'parse', content: [text(`pages: 1\nout: ${hash}/extracted.txt`)] }] }]);
  const result = await prepareMaterials([file('brief.pdf', 100, `sha256:${hash}`)], { readFileStream() {} }, { evidence });
  assert.equal(result.files[0].status, 'needs_tool');
});

test('conversation-wide opt-out survives a compacted derived message list', () => {
  const disabled = { ...user([text('For the rest of this conversation, do not make extra model calls.')]), id: 'earlier' };
  const agent = { session: { deriveMessages: () => [], snapshotEvents: () => [{ type: 'user/message', data: { message: disabled } }] } };
  assert.equal(buildInput(agent, [user([text('Continue.')])]), undefined);
});

test('shell byte counts and output redirections do not count as displayed attachment content', async () => {
  const hash = 'e'.repeat(64);
  for (const command of [`cat "${hash}/extracted.txt" | wc -c`, `(Get-Content "${hash}/extracted.txt" -Raw).Length`,
    `Get-Content "${hash}/extracted.txt" | Measure-Object`, `cat "${hash}/extracted.txt" > /dev/null`]) {
    const evidence = toolEvidence([{ content: [{ type: 'tool-call', id: 'metadata', name: command.startsWith('cat') ? 'bash' : 'pwsh', arguments: JSON.stringify({ command }) }] },
      { content: [{ type: 'tool-result', toolCallId: 'metadata', content: [text('385')] }] }]);
    assert.equal((await prepareMaterials([file('brief.pdf', 100, `sha256:${hash}`)], { readFileStream() {} }, { evidence })).files[0].status, 'needs_tool', command);
  }
});
