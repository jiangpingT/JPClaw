import type { Provider } from "./types.js";
import type { JPClawConfig, ProviderConfig } from "../shared/config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

export function resolveProvider(config: JPClawConfig): Provider | null {
  const providerConfig = config.providers.find((entry) => entry.apiKey);
  if (!providerConfig) return null;
  return instantiateProvider(providerConfig);
}

function instantiateProvider(config: ProviderConfig): Provider {
  if (config.type === "anthropic") {
    return new AnthropicProvider(config);
  }
  return new OpenAIProvider(config);
}
