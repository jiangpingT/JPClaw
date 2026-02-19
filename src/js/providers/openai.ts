import type { AgentMessage } from "../core/messages.js";
import type { Provider, ProviderResponse } from "./types.js";
import type { ProviderConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { recordMetric } from "../shared/metrics.js";

type OpenAIResponse = {
  output?: {
    type?: string;
    content?: { type?: string; text?: string }[];
  }[];
};

export class OpenAIProvider implements Provider {
  name = "openai";
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async generate(messages: AgentMessage[]): Promise<ProviderResponse> {
    const startedAt = Date.now();
    const endpoint = new URL("/v1/responses", this.config.baseUrl || "https://api.openai.com");
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.config.authHeader && this.config.apiKey) {
      const prefix = this.config.authScheme ? `${this.config.authScheme} ` : "";
      headers[this.config.authHeader] = `${prefix}${this.config.apiKey}`;
    }

    const system = messages.find((message) => message.role === "system")?.content;
    const conversation = messages
      .filter((message) => message.role !== "system")
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n");

    if (!this.config.model) {
      throw new Error("OpenAI model is not configured (OPENAI_MODEL).");
    }

    const body = {
      model: this.config.model,
      instructions: system,
      input: conversation
    };

    // P1-NEW-2修复: 添加重试机制（与 Anthropic Provider 一致）
    const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || "30000");
    const maxAttempts = Number(process.env.OPENAI_RETRY_ATTEMPTS || "2");
    let lastError: unknown;
    let response: Response | null = null;

    for (let attempt = 1; attempt <= Math.max(maxAttempts, 1); attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });

        // 5xx 错误且还有重试次数时，等待后重试
        if (!response.ok && response.status >= 500 && attempt < maxAttempts) {
          log("warn", "provider.openai.retry", { attempt, status: response.status });
          await new Promise(r => setTimeout(r, 350 * attempt));
          continue;
        }
        break;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          log("warn", "provider.openai.retry", { attempt, error: String(error) });
          await new Promise(r => setTimeout(r, 350 * attempt));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    if (!response) {
      recordMetric("provider.openai", { ok: false, durationMs: Date.now() - startedAt, meta: { noResponse: true } });
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    if (!response.ok) {
      const errorText = await response.text();
      log("error", "provider.openai.error", { status: response.status, body: errorText });
      recordMetric("provider.openai", { ok: false, durationMs: Date.now() - startedAt, meta: { status: response.status } });
      throw new Error(`OpenAI request failed: ${response.status}`);
    }

    const data = (await response.json()) as OpenAIResponse;
    const text = extractOutputText(data);

    recordMetric("provider.openai", { ok: true, durationMs: Date.now() - startedAt });
    return { text, raw: data };
  }
}

function extractOutputText(payload: OpenAIResponse): string {
  const outputs = payload.output || [];
  const texts: string[] = [];
  for (const item of outputs) {
    if (!item?.content) continue;
    for (const part of item.content) {
      if (part?.type === "output_text" && part.text) {
        texts.push(part.text);
      }
    }
  }
  return texts.join("\n");
}
