import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * The installed host's LLM module as an absolute file URL.
 *
 * A preset that ships inside a package cannot hardcode the harness
 * installation path, so the plugin resolves the host's own module from its own
 * location. The profile's `node_modules` fallback links host packages to the
 * running installation, so this resolves to the same module instance the host
 * loads. An explicit `llmModule` config still wins for test fixtures and for
 * deployments that vendor the runtime elsewhere.
 */
export function hostLlmModuleUrl() {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-llm')).href;
  } catch {
    return undefined;
  }
}

/** Use the active Loader so Desktop's ASAR host wins over an older CLI install. */
export async function hostLlmModule(ctx, explicitUrl) {
  if (explicitUrl !== undefined) {
    if (typeof explicitUrl !== 'string' || !explicitUrl.startsWith('file:///')) throw new Error('final-review requires the installed DSH LLM module URL');
    return import(explicitUrl);
  }
  if (ctx.loader?.import) return ctx.loader.import('@deepseek-ai/dsh-llm', ctx.baseUrl, {});
  const url = hostLlmModuleUrl();
  if (!url) throw new Error('final-review cannot resolve the installed DSH LLM module');
  return import(url);
}
