import { TOOL_SEARCH, SKILL_SEARCH } from './discovery-schemas.mjs';
import { currentUserLast } from './agent-context.mjs';
import { REASONING_GUIDANCE } from './reasoning-guidance.mjs';

export const name = 'reasoning-support-adaptive-context';
export const inject = ['tools', 'skills'];

export const NATIVE_TOOLS = new Set([
  'pwsh', 'bash', 'read', 'read_image', 'write', 'edit', 'glob', 'grep',
  'job_list', 'job_output', 'job_kill', 'ask_user_question', 'exit_plan_mode',
  'skill', 'create_goal', 'get_goal', 'update_goal', 'todo_write', 'subagent',
  'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent', 'workflow',
  'ralph', 'web_fetch', 'web_search', 'present', TOOL_SEARCH.name, SKILL_SEARCH.name,
]);

const TOOL_GUIDE_TARGETS = {
  'tool:pwsh': ['pwsh'], 'tool:read': ['read'], 'tool:write': ['write'],
  'tool:edit': ['edit'], 'tool:glob': ['glob'], 'tool:grep': ['grep'],
  'tool:jobs': ['job_list', 'job_output', 'job_kill'],
  'tool:web_search': ['web_search'], 'tool:web_fetch': ['web_fetch'],
  'tool:goal': ['create_goal', 'get_goal', 'update_goal'],
  'tool:workflow': ['workflow'], 'tool:ralph': ['ralph'],
  'tool:subagent': ['subagent'], 'tool:subagent_fork': ['subagent_fork'],
};
const QUERY_STOP_WORDS = new Set(['a', 'an', 'the', 'is', 'are', 'i', 'we', 'you', 'can', 'could', 'please', 'get', 'find', 'show', 'me', 'my', 'for', 'of', 'and', 'or', 'to', 'with', 'using', 'tool', 'tools', 'skill', 'skills']);
const CJK_STOP_WORDS = new Set(['帮我', '请帮', '查找', '寻找', '一个', '工具', '技能', '可以', '能够', '使用', '需要', '相关', '关于', '用于', '进行']);

export function searchEntries(entries, query, limit = 5) {
  const normalized = query.normalize('NFKC').trim().toLowerCase();
  const exact = entries.find(entry => entry.name.normalize('NFKC').toLowerCase() === normalized);
  if (exact) return [exact];
  const fragments = (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).flatMap(word => word.match(/\p{Script=Han}+|[^\p{Script=Han}]+/gu) ?? []);
  const terms = [...new Set(fragments.flatMap(term => /^\p{Script=Han}{3,}$/u.test(term)
    ? [term, ...Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2))] : [term])
    .filter(term => !QUERY_STOP_WORDS.has(term) && !CJK_STOP_WORDS.has(term) && (term.length > 1 || /[^\x00-\x7F]/.test(term))))];
  return entries.map(entry => {
    const entryName = entry.name.toLowerCase();
    const text = `${entryName} ${entry.description ?? ''}`.normalize('NFKC').toLowerCase();
    const coverage = terms.filter(term => text.includes(term)).length;
    const nameHits = terms.filter(term => entryName.includes(term)).length;
    const score = coverage * 100 + nameHits * 5;
    return { entry, score };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit).map(item => item.entry);
}

/** Preserve personas and unknown contributions; keep first-party tool guidance on its tools. */
export function shapePrompt(assembly) {
  const descriptions = new Map(assembly.tools.map(tool => [tool.name, tool.description]));
  const sections = [];
  for (const section of assembly.sections) {
    const targets = TOOL_GUIDE_TARGETS[section.name]?.filter(target => descriptions.has(target));
    if (!targets?.length) { sections.push(section); continue; }
    for (const target of targets) descriptions.set(target, `${descriptions.get(target)}\n\n${section.text}`);
  }
  return {
    ...assembly, sections: [...sections, { name: 'reasoning-support:reasoning', text: REASONING_GUIDANCE }],
    tools: assembly.tools.map(tool => descriptions.get(tool.name) === tool.description ? tool : { ...tool, description: descriptions.get(tool.name) }),
  };
}

export function compactSkillCatalog(message) {
  if (message.source?.kind !== 'skill-catalog') return message;
  const count = message.source.entries?.length;
  return {
    ...message,
    content: [{ type: 'text', text: `Installed skills${count === undefined ? '' : `: ${count}`}. Use skill_search for relevant names and descriptions, then the native skill tool to load a selected skill. Explicit skill instructions and project instructions remain applicable.` }],
  };
}

/** Read only successful results produced by this discovery tool, never arbitrary log text. */
export function restoredTools(events) {
  const ownCalls = new Set();
  let selected = [];
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.name === TOOL_SEARCH.name) ownCalls.add(event.data.callId);
    if (event.type !== 'tool/result') continue;
    for (const block of event.data.message?.content ?? []) {
      if (block.type !== 'tool-result' || block.isError || !ownCalls.has(block.toolCallId)) continue;
      for (const content of block.content ?? []) {
        if (content.type !== 'text') continue;
        let value;
        try { value = JSON.parse(content.text); } catch { continue; }
        if (value?.reasoningSupportDiscovery === 1 && Array.isArray(value.enabledTools) && value.enabledTools.every(tool => typeof tool === 'string')) selected = value.enabledTools;
      }
    }
  }
  return [...new Set(selected)];
}

const jsonOutput = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; },
};

function validateQuery(args) {
  if (!args || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 256 || Object.keys(args).some(key => key !== 'query')) {
    throw new Error('Provide a non-empty query of at most 256 characters.');
  }
}

export function apply(ctx, config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !['maxAdditionalTools', 'allTools'].includes(key))) {
    throw new Error('reasoning-support-adaptive-context: unsupported configuration');
  }
  const maxAdditionalTools = config.maxAdditionalTools ?? 12;
  if (!Number.isInteger(maxAdditionalTools) || maxAdditionalTools < 5 || maxAdditionalTools > 100 ||
      (config.allTools !== undefined && typeof config.allTools !== 'boolean')) {
    throw new Error('reasoning-support-adaptive-context: invalid tool exposure policy');
  }
  const states = new WeakMap();
  function stateFor(agent) {
    let state = states.get(agent);
    if (!state) {
      state = { selected: restoredTools(agent.session.snapshotEvents?.() ?? []), catalog: [], visibleTools: new Set(), cwd: undefined };
      states.set(agent, state);
    }
    return state;
  }

  ctx.effect(() => ctx.tools.register({
    ...TOOL_SEARCH, output: jsonOutput,
    async execute(args, exec) {
      validateQuery(args);
      if (!exec.agent) throw new Error('Tool discovery requires an owning agent.');
      exec.signal.throwIfAborted();
      const state = stateFor(exec.agent);
      const tools = searchEntries(state.catalog.filter(tool => ![TOOL_SEARCH.name, SKILL_SEARCH.name].includes(tool.name) && ctx.tools.get(tool.name, exec.agent)), args.query);
      const additions = tools.filter(tool => !NATIVE_TOOLS.has(tool.name)).map(tool => tool.name);
      state.selected = [...state.selected.filter(tool => !additions.includes(tool)), ...additions].slice(-maxAdditionalTools);
      return {
        reasoningSupportDiscovery: 1, enabledTools: state.selected,
        tools: tools.map(tool => ({ name: tool.name, description: tool.description })),
        next: tools.length ? 'These tools are directly callable by their native names in the next model step.' : 'No matching tools in the currently registered agent scope. Refine the query or report the specific missing capability.',
      };
    },
  }));
  ctx.effect(() => ctx.tools.register({
    ...SKILL_SEARCH, output: jsonOutput,
    async execute(args, exec) {
      validateQuery(args);
      if (!exec.agent) throw new Error('Skill discovery requires an owning agent.');
      const state = stateFor(exec.agent);
      const skills = await ctx.skills.list({ scope: exec.agent, cwd: state.cwd, signal: exec.signal });
      exec.signal.throwIfAborted();
      return {
        skills: searchEntries(skills.filter(skill => skill.invocation.modelInvocable), args.query).map(skill => ({ name: skill.name, description: skill.description })),
        next: 'Load a selected name with the native skill tool. Use the actual tool definitions in this environment when a skill describes another client.',
      };
    },
  }));

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next();
    if (!context.agent) return assembled;
    const assembly = shapePrompt(assembled);
    const state = stateFor(context.agent);
    state.catalog = assembly.tools;
    state.cwd = assembly.variables.cwd;
    state.selected = state.selected.filter(tool => assembly.tools.some(candidate => candidate.name === tool)).slice(-maxAdditionalTools);
    const visibleTools = config.allTools ? assembly.tools : assembly.tools.filter(tool => NATIVE_TOOLS.has(tool.name) || state.selected.includes(tool.name));
    state.visibleTools = new Set(visibleTools.map(tool => tool.name));
    return {
      ...assembly,
      tools: visibleTools,
    };
  }, { prepend: true });
  ctx.on('agent/pre-step', async ({ agent, messages: claimed }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    const visible = states.get(agent)?.visibleTools;
    const canLoadSkills = visible?.has(SKILL_SEARCH.name) && visible.has('skill') && ctx.tools.get(SKILL_SEARCH.name, agent) && ctx.tools.get('skill', agent);
    const messages = canLoadSkills ? decision.messages.map(compactSkillCatalog) : decision.messages;
    return { ...decision, messages: currentUserLast(claimed, messages) };
  }, { prepend: true });
}
