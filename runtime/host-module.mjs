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
