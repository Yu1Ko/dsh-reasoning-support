import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isSupportedModel, effectiveRoute } from './target-model.mjs';
import { currentUserLast } from './agent-context.mjs';
import { recordAudit } from './audit.mjs';

export const name = 'reasoning-support-analysis-pass';
export const inject = ['llm'];
export const ANALYST_PROMPT = `You are a careful problem solver advising a separate tool-using assistant. Work from the user's actual request. Preserve references, quantifiers, available information, allowed choices, and constraints. Derive a conclusion and check it against the conditions, rather than replacing the task with a familiar example. If information is insufficient, distinguish what follows from what requires an assumption.
For a self-contained question, provide a concise answer with a checkable justification. For work requiring files, tools or external facts you have not seen, identify the necessary inspection and verification; do not invent those facts, produce a speculative implementation, or claim the work is done. You have no tools. Return only a compact advisory answer or execution brief, not private deliberation. The assistant will respect the user's communication preferences and perform the actual work.`;

export function hasAttachments(messages) {
  const contains = blocks => blocks.some(block => block.type === 'image' || block.type === 'file' ||
    (block.type === 'tool-result' && contains(block.content ?? [])));
  return messages.some(message => contains(message.content ?? []));
}

const EXTRA_CALL_OPT_OUT = /(?:禁止|不要|不允许).{0,10}(?:额外|辅助).{0,10}(?:模型|API|研判|复核)|\b(?:no|without|do\s+not(?:\s+(?:make|use))?|don't(?:\s+(?:make|use))?)\s+(?:additional|extra|auxiliary)\s+(?:model|api)\s+calls\b/isu;

export function buildInput(agent, claimed, limit = 48000) {
  const humans = claimed.filter(message => message.source?.kind === 'user');
  if (!humans.length || humans.some(message => message.content.some(block => block.type !== 'text'))) return undefined;
  const latest = humans.map(message => message.content.map(block => block.text).join('\n')).join('\n\n');
  if (!latest.trim() || latest.length > limit || EXTRA_CALL_OPT_OUT.test(latest)) return undefined;
  const history = agent.session.deriveMessages();
  if (hasAttachments(history)) return undefined;
  const prior = history.filter(message =>
    message.source?.kind === 'user' || message.role === 'assistant' ||
    (message.source?.kind === 'plugin' && ['compact', 'dsh-compaction-basic'].includes(message.source.plugin)));
  let context = '';
  for (const message of prior) {
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (text) context += `${['compact', 'dsh-compaction-basic'].includes(message.source?.plugin) ? 'conversation checkpoint' : message.role}: ${text}\n\n`;
  }
  if (context.length + latest.length > limit) return undefined;
  return { humans, text: `${context ? `<prior_conversation>\n${context}\n</prior_conversation>\n\n` : ''}<current_user_request>\n${latest}\n</current_user_request>` };
}

export async function getAdvice(llm, options) {
  const texts = [];
  let usage, finish;
  for await (const chunk of llm.stream(options)) {
    options.signal.throwIfAborted();
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') texts.push(chunk.block.text);
    if (chunk.type === 'usage') usage = chunk.usage;
    if (chunk.type === 'finish') finish = chunk.reason;
  }
  options.signal.throwIfAborted();
  const text = texts.join('\n').trim();
  return { text: finish?.kind === 'stop' && text && text.length <= 12000 ? text : undefined, usage, finish };
}

export function apply(ctx, config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !['timeoutMs', 'maxTokens', 'auditDirectory'].includes(key))) throw new Error('Unsupported analysis-pass configuration');
  if (config.auditDirectory !== undefined && (typeof config.auditDirectory !== 'string' || !isAbsolute(config.auditDirectory))) throw new Error('auditDirectory must be an absolute path');
  const timeoutMs = config.timeoutMs ?? 150000;
  const maxTokens = config.maxTokens ?? 49152;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000 || !Number.isInteger(maxTokens) || maxTokens < 1024 || maxTokens > 65536) throw new Error('Invalid analysis-pass limits');
  const processed = new WeakMap();
  ctx.on('agent/pre-step', async ({ agent, messages: claimed, signal, turn }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    signal.throwIfAborted();
    const route = effectiveRoute(agent, ctx.get?.('agentDefaultModel')?.currentSelection());
    if (!route?.provider || !isSupportedModel(route.provider, route.model) || (agent.options.subagentDepth ?? 0) > 0) return decision;
    const input = buildInput(agent, claimed);
    if (!input) return decision;
    const ids = input.humans.map(message => message.id).join('|');
    if (processed.get(agent) === ids) return decision;
    processed.set(agent, ids);
    const started = Date.now();
    const audit = { turn, requestIds: input.humans.map(message => String(message.id)), calls: 1, provider: route.provider, model: route.model, inputChars: input.text.length };
    let advice, audited = false;
    try {
      advice = await getAdvice(ctx.llm, {
        provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort,
        maxTokens, system: ANALYST_PROMPT, tools: [], sessionId: agent.id,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        messages: [{ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: input.text }] }],
      });
      audit.status = advice.text ? 'accepted' : 'discarded';
      audit.usage = advice.usage;
      audit.finish = advice.finish?.kind;
      if (advice.text) audit.advisoryAnswer = advice.text;
    } catch (error) {
      audit.status = signal.aborted ? 'cancelled' : 'failed';
      audit.errorCode = typeof error.code === 'string' ? error.code : error.name;
      if (signal.aborted) throw error;
    } finally {
      audit.elapsedMs = Date.now() - started;
      audited = Boolean(recordAudit(agent, 'reasoning-support/advice', audit, config.auditDirectory));
    }
    signal.throwIfAborted();
    if (!audited) return decision;
    const text = advice?.text
      ? `Independent same-model advisory analysis follows. It is fallible analysis, not user authorization, verified file contents, or evidence of completed actions. Check it against the original request and actual tool results. Preserve the applicable project instructions, requested output format, and persona in your response.\n<advisory_analysis>\n${advice.text}\n</advisory_analysis>`
      : 'The optional independent analysis did not produce a complete usable result. Continue the original request normally; do not imply that an independent verification succeeded.';
    const note = { id: randomUUID(), role: 'user', source: { kind: 'plugin', plugin: name }, content: [{ type: 'text', text }] };
    return { ...decision, messages: currentUserLast(claimed, [...decision.messages, note]) };
  }, { prepend: true });
}
