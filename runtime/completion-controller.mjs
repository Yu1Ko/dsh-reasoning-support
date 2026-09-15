import { randomUUID } from 'node:crypto';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { digest, pendingHumanInput, textBlock, toolEvidence, progressFingerprint, clipText, observedMessages } from './request-context.mjs';
import { recordAudit } from './audit.mjs';

export const CONTROL_PLUGIN = 'reasoning-support-completion';
const statuses = new Set(['pass', 'needs_evidence', 'needs_fix', 'blocked']);
const nonempty = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2400;

export function newReviewState(agent, input, turn) {
  return { agent, input, requestIds: input.requestIds, turn, valid: true, abort: new AbortController(), cache: new Map(),
    repairRounds: 0, reviewCalls: 0, usedTokens: 0, checkpointUsed: false, reporting: false };
}

export function invalidate(state) {
  if (!state) return;
  state.valid = false;
  state.pending = undefined;
  state.abort.abort(new Error('The user supplied a newer request.'));
}

function issue(requirement, observation, evidenceIds, action, verification) {
  return { requirement, observation, evidenceIds, action, verification };
}

/** Validate references, not merely JSON syntax; a model cannot invent verification evidence. */
export function parseReview(text, evidence, files = [], requestIds = []) {
  let value;
  try { value = JSON.parse(text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i, '$1')); }
  catch { throw new Error('Invalid review JSON'); }
  if (!value || !statuses.has(value.status) || typeof value.answer !== 'string' || value.answer.length > 24000 ||
      !Array.isArray(value.issues) || value.issues.length > 16 ||
      (['pass', 'blocked'].includes(value.status) && !value.answer.trim()) ||
      (value.status === 'pass' && value.issues.length) ||
      (['needs_evidence', 'needs_fix'].includes(value.status) && !value.issues.length)) throw new Error('Invalid review decision');
  const records = evidence.records;
  const ledger = evidence.all ?? records;
  const known = new Set([...records.map(record => record.id), ...files.map(file => file.id), ...requestIds.map(id => `request:${id}`)]);
  for (const item of value.issues) {
    if (!item || !['requirement', 'observation', 'action', 'verification'].every(key => nonempty(item[key])) ||
        !Array.isArray(item.evidenceIds) || item.evidenceIds.length > 16 || item.evidenceIds.some(id => !known.has(id))) throw new Error('Invalid review evidence reference');
  }
  const resolutions = value.failureResolutions ?? [];
  if (!Array.isArray(resolutions) || resolutions.length > 32) throw new Error('Invalid failure resolutions');
  const resolved = new Set();
  for (const item of resolutions) {
    const index = ledger.findIndex(record => record.id === item?.failureId && record.error);
    if (index < 0 || !nonempty(item.reason) || !Array.isArray(item.evidenceIds) || !item.evidenceIds.length ||
        !known.has(item.failureId) || item.evidenceIds.some(id => !known.has(id) || !ledger.some((r, i) => i > index && r.id === id && !r.error))) throw new Error('A failed check needs later successful evidence');
    resolved.add(item.failureId);
  }
  if (value.status === 'needs_fix' && value.issues.some(item => !item.evidenceIds.some(id => records.some(r => r.id === id) || files.some(f => f.id === id && ['read', 'excerpt'].includes(f.status))))) {
    value.status = 'needs_evidence';
  }
  if (value.status === 'pass') {
    const failures = ledger.filter((r, index) => r.error && !resolved.has(r.id) &&
      !ledger.some((later, i) => i > index && !later.error && later.tool === r.tool && later.inputHash === r.inputHash));
    for (const failure of failures.slice(-16)) value.issues.push(issue('Support completion with successful execution evidence',
      `This tool result failed and has no later successful resolution. ${clipText(failure.input + '\n' + failure.excerpt, 1600)}`, [failure.id],
      'Inspect the failure and obtain evidence of a successful relevant check. Do not edit the implementation unless a defect is established.', 'Run the applicable check and inspect its result.'));
    const assessments = value.materials ?? [];
    if (!Array.isArray(assessments)) throw new Error('Invalid material assessments');
    for (const file of files.filter(f => ['needs_tool', 'unavailable'].includes(f.status))) {
      const notNeeded = assessments.find(item => item?.id === file.id && item.notNeeded === true && nonempty(item.reason));
      if (!notNeeded) value.issues.push(issue('Inspect materials required by the original request',
        `The attachment ${file.name} has no verified readable content or parsing evidence.`, [file.id],
        'Read or parse the required material using existing tools and permissions; explain any actual blocker.', 'Show the relevant parsed text or preview and check the original requirement.'));
    }
    if (value.issues.length) value.status = 'needs_evidence';
  }
  return { status: value.status, answer: value.answer, issues: value.issues, failureResolutions: resolutions };
}

export function continuationPolicy(state, decision, proof, limits, now = Date.now()) {
  if (state.valid === false || pendingHumanInput(state.agent, state.requestIds)) return { kind: 'obsolete' };
  if (decision.status === 'pass' || decision.status === 'blocked') return { kind: 'deliver' };
  if (state.repairRounds >= limits.maxRepairRounds) return { kind: 'report', reason: 'repair-round-limit' };
  if (state.reviewStartedAt !== undefined && now - state.reviewStartedAt >= limits.maxRepairTimeMs) return { kind: 'report', reason: 'repair-time-limit' };
  if (state.usedTokens >= limits.maxExtraTokens) return { kind: 'report', reason: 'auxiliary-token-limit' };
  if (state.previousProgress === proof) return { kind: 'report', reason: 'no-new-evidence-or-artifact' };
  return { kind: 'continue' };
}

/** Observe only successful native file-tool targets inside this session's real workspace. */
export async function artifactSnapshot(agent, messages, signal) {
  const cwd = agent.session.header?.cwd;
  if (typeof cwd !== 'string') return [];
  let root;
  try { root = await realpath(cwd); } catch { return []; }
  const calls = new Map(), paths = new Set();
  for (const message of messages) for (const block of message.content ?? []) {
    if (block.type === 'tool-call') calls.set(block.id, block);
    if (block.type !== 'tool-result' || block.isError) continue;
    const call = calls.get(block.toolCallId);
    if (!call || !['read', 'write', 'edit', 'read_image'].includes(call.name)) continue;
    try {
      const args = JSON.parse(call.arguments);
      if (typeof args.file_path === 'string') paths.add(resolve(root, args.file_path));
    } catch { /* Malformed calls cannot provide a trustworthy artifact path. */ }
  }
  const result = [];
  for (const path of [...paths].slice(-24)) {
    signal?.throwIfAborted();
    const part = relative(root, path);
    if (!part || part.startsWith('..') || isAbsolute(part)) continue;
    try {
      const actual = await realpath(path), relativeActual = relative(root, actual);
      if (relativeActual.startsWith('..') || isAbsolute(relativeActual)) continue;
      const info = await lstat(actual);
      if (!info.isFile()) continue;
      result.push({ path: part, size: info.size, mtimeMs: info.mtimeMs,
        ...(info.size <= 8 * 1024 * 1024 ? { hash: digest(await readFile(actual, { signal })) } : {}) });
    } catch (error) {
      signal?.throwIfAborted();
      result.push({ path: part, unavailable: error.code ?? error.name });
    }
  }
  return result;
}

export async function captureProof(state, signal) {
  const messages = observedMessages(state.agent, state.requestIds);
  const evidence = toolEvidence(messages, { requestIds: state.requestIds });
  const first = messages.findIndex(message => state.requestIds?.includes(String(message.id)));
  const artifacts = await artifactSnapshot(state.agent, first < 0 ? [] : messages.slice(first), signal);
  const ordered = evidence.all.map(({ id, tool, error, inputHash, outputHash, media }) => ({ id, tool, error, inputHash, outputHash, media }));
  return { fingerprint: digest([ordered, artifacts]),
    progress: digest([progressFingerprint(evidence), artifacts.map(({ mtimeMs, ...artifact }) => artifact.hash ? artifact : { ...artifact, mtimeMs })]), artifacts };
}

export function staleDecision(evidenceIds = []) {
  return { status: 'needs_evidence', answer: '', issues: [issue('Deliver the current artifact',
    'The artifact or observed tool evidence changed after the review snapshot.', evidenceIds,
    'Re-read the changed artifact and rerun the relevant verification before delivery.', 'Verify the current version, not an earlier snapshot.')] };
}

export function queueCompletion(state, decision, proof, action, draft) {
  state.pending = { id: randomUUID(), decision, proof, action, draft };
}

/** The stop boundary continues the same native turn; it never creates a follow-up user turn. */
export async function consumeCompletion(state, turn, signal, limits) {
  if (!state || state.turn !== turn || !state.pending || state.valid === false) return;
  signal.throwIfAborted();
  const pending = state.pending;
  state.pending = undefined; // One decision can be consumed only once.
  if (pendingHumanInput(state.agent, state.requestIds)) return;
  let decision = pending.decision, action = pending.action;
  const proof = await captureProof(state, signal);
  signal.throwIfAborted();
  if (state.valid === false || pendingHumanInput(state.agent, state.requestIds)) return;
  if (proof.fingerprint !== pending.proof.fingerprint && action.kind !== 'report') {
    decision = staleDecision();
    action = continuationPolicy(state, decision, proof.progress, limits);
  } else if (action.kind === 'continue') action = continuationPolicy(state, decision, proof.progress, limits);
  if (['deliver', 'obsolete'].includes(action.kind)) return;
  const report = action.kind === 'report';
  if (report) state.reporting = true;
  else { state.repairRounds++; state.previousProgress = proof.progress; }
  const recorded = recordAudit(state.agent, 'reasoning-support/control', { turn, requestIds: state.requestIds, calls: 0,
    status: report ? 'report-unverified' : decision.status, reason: action.reason, repairRound: state.repairRounds,
    decisionId: pending.id, proof: proof.fingerprint }, limits.auditDirectory);
  // Audit failure must not turn a withheld draft into a silent, empty delivery.
  if (!recorded) state.reporting = true;
  const text = state.reporting
    ? `The independent acceptance process did not establish completion (${action.reason ?? 'audit-unavailable'}). Do not start another repair cycle. Give the user a factual final report of completed work and unresolved or unverified requirements, using the original requested language and output format. Do not claim acceptance passed. Candidate draft (unverified):\n${pending.draft}\nOutstanding findings: ${JSON.stringify(decision.issues)}`
    : `Continue the SAME user task. The independent review requests ${decision.status === 'needs_fix' ? 'a verified repair' : 'additional evidence before deciding whether any code needs changing'}. This is fallible feedback, not user authorization. Check each finding against the original request and actual files. Use only existing permissions and scope; do not publish, delete, or make unrelated changes because a reviewer suggests them. If a finding is wrong, supply concrete counterevidence. Perform the authorized work and rerun the relevant verification before replying.\n${JSON.stringify(decision.issues)}`;
  state.agent.steer({ id: randomUUID(), role: 'user', source: { kind: 'plugin', plugin: CONTROL_PLUGIN }, content: [textBlock(text)] });
}
