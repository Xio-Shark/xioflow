// Access to xiocode's runtime (TypeScript sources, loaded directly by Node) and to the user's configured
// model providers. The API key is read from the environment variable the provider names in
// ~/.xiocode/config.toml; it is never written to disk or printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const XIOCODE_ROOT = process.env.XIOCODE_ROOT ?? path.join(os.homedir(), 'code/xiocode');
export const loadXiocode = (rel) => import(pathToFileURL(path.join(XIOCODE_ROOT, rel)).href);

/** `provider` defaults to the configured default; `model` defaults to that provider's configured model. */
export async function openModel({ provider, model } = {}) {
  const { ExtensionHost, createLlmClient, resolveApiKey } = await loadXiocode('src/runtime/index.ts');
  const { registerConfiguredProviders } = await loadXiocode('src/runtime/provider-registry.ts');
  const { parseXioConfig } = await loadXiocode('src/cli/config-parser.ts');
  const { runtimeConfig } = parseXioConfig(fs.readFileSync(path.join(os.homedir(), '.xiocode/config.toml'), 'utf8'));
  const providerName = provider ?? runtimeConfig.general.defaultProvider;
  const host = new ExtensionHost();
  registerConfiguredProviders(host, runtimeConfig);
  const configured = host.getProvider(providerName);
  if (!configured) throw new Error(`provider "${providerName}" is not configured in ~/.xiocode/config.toml`);
  const modelId = model ?? configured.models[0].id;
  // The registration lists the provider's configured model; another model of the same provider reuses its settings.
  const registration = configured.models.some((m) => m.id === modelId)
    ? configured
    : { ...configured, models: [{ ...configured.models[0], id: modelId, name: modelId }] };
  // Keys the user stored with xiocode (credentials.json) fill in for environment variables that are not set.
  // They go into a private copy of the environment, not into process.env.
  const { applyCredentialsToEnv } = await loadXiocode('src/cli/credentials.ts');
  const env = { ...process.env };
  await applyCredentialsToEnv(env, runtimeConfig.providers);
  const apiKey = resolveApiKey(registration, env);
  // A rejected request is otherwise only a status code: show the provider's reason, with the key taken out.
  const fetchImpl = async (url, init) => {
    const response = await fetch(url, init);
    if (!response.ok) {
      const text = (await response.clone().text()).split(apiKey).join('<key>');
      console.error(`LLM request rejected: HTTP ${response.status} ${text.slice(0, 400)}`);
    }
    return response;
  };
  return {
    providerName, modelId, registration, apiKey,
    model: { provider: providerName, id: modelId, name: modelId, api: registration.api },
    client: createLlmClient({ registration, apiKey, fetchImpl }),
  };
}
