import type { AgentMessage } from "../core/messages.js";

export type ProviderResponse = {
  text: string;
  raw?: unknown;
};

export interface Provider {
  generate(messages: AgentMessage[], traceId?: string): Promise<ProviderResponse>;
  name: string;
}
