/** The installed DSH catalog names deepseek-official/deepseek-flash as DeepSeek-V41-Flash. */
export function isSupportedModel(provider, model) {
  return (provider === 'deepseek-official' && model === 'deepseek-flash') || /(?:^|\/)deepseek-v4(?:\.1|1)(?:-|$)/i.test(model ?? '');
}

/** Follow DSH's pending selection until a matching request header consumes it. */
export function effectiveRoute(agent, defaultSelection) {
  let pending, used;
  for (const event of agent.session.snapshotEvents?.() ?? []) {
    if (event.type === 'model/selection') pending = event.data;
    if (event.type === 'request/header') {
      const header = event.data.header;
      used = { provider: header.config.provider, model: header.config.model,
        ...(header.adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort: header.config.reasoningEffort }) };
      if (pending && pending.provider === header.config.provider && pending.model === header.config.model && pending.reasoningEffort === header.config.reasoningEffort) pending = undefined;
    }
  }
  return pending ?? used ?? (agent.options.provider && agent.options.model ? agent.options : defaultSelection);
}
