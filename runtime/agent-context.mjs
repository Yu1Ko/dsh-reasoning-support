export const name = 'reasoning-support-agent-context';
export const inject = [];

export const AGENCY_GUIDANCE = `You are operating a real agent environment. The supplied tool definitions are callable capabilities, not examples. When the user asks you to create, inspect, change, run or verify an artifact, carry out the work with the available tools, subject to the user's restrictions and applicable project instructions. A code block alone does not complete a request to build something in the workspace.

Respect the user's language and communication preferences while being exact about facts, actions and results. A tool catalog or skill catalog describes available resources; it does not replace the user's current task. Use the resources relevant to that task.

Reason from the actual conditions of the current request. Check that your interpretation and conclusion account for those conditions; do not substitute a familiar problem. For executable work, inspect the needed context, perform the work, and verify the important result. Report what the evidence establishes and any remaining blocker.`;

/** Keep every contribution intact; add task guidance without replacing a persona. */
export function addAgencyGuidance(assembly) {
  if (!Array.isArray(assembly.sections) || !Array.isArray(assembly.tools) || !Array.isArray(assembly.contexts)) {
    throw new Error('reasoning-support-agent-context: incompatible prompt assembly');
  }
  if (assembly.sections.some(section => section.name === name)) return assembly;
  return { ...assembly, sections: [...assembly.sections, { name, text: AGENCY_GUIDANCE }] };
}

/** Move only current human requests, retaining all message objects and their provenance. */
export function currentUserLast(claimed, messages) {
  if (!Array.isArray(claimed) || !Array.isArray(messages)) {
    throw new Error('reasoning-support-agent-context: incompatible pre-step message contract');
  }
  const human = claimed.filter(message => message.source?.kind === 'user');
  const ids = new Set(human.map(message => message.id).filter(Boolean));
  const isCurrentHuman = message => human.includes(message) || (message.id && ids.has(message.id));
  const tasks = messages.filter(isCurrentHuman);
  if (tasks.length === 0) return messages;
  return [...messages.filter(message => !isCurrentHuman(message)), ...tasks];
}

export function apply(ctx, config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(key => !['guidance', 'userLast'].includes(key)) ||
      Object.values(config).some(value => typeof value !== 'boolean')) {
    throw new Error('reasoning-support-agent-context: guidance and userLast must be booleans');
  }
  if (config.guidance !== false) {
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next();
      return context.agent ? addAgencyGuidance(assembly) : assembly;
    }, { prepend: true });
  }
  if (config.userLast !== false) {
    ctx.on('agent/pre-step', async ({ messages: claimed }, next) => {
      const decision = await next();
      if (decision.kind === 'reject') return decision;
      return { ...decision, messages: currentUserLast(claimed, decision.messages) };
    }, { prepend: true });
  }
}
