import type { AgentMessage } from "../core/messages.js";
import type { Provider, ProviderResponse } from "./types.js";
import type { ProviderConfig } from "../shared/config.js";
import { log, logError, logMetric } from "../shared/logger.js";
import { recordMetric } from "../shared/metrics.js";
import { ErrorCode, JPClawError, ErrorHandler } from "../shared/errors.js";
import { tracer } from "../shared/trace.js";

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string;
};

type AnthropicResponse = {
  content?: { type: string; text?: string }[];
};

export class AnthropicProvider implements Provider {
  name = "anthropic";
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async generate(messages: AgentMessage[], traceId?: string): Promise<ProviderResponse> {
    return await tracer.trace("anthropic.generate", async (span) => {
      span.setTags({
        provider: "anthropic",
        model: this.config.model || "unknown"
      });

      const startedAt = Date.now();
      const endpoint = new URL("/v1/messages", this.config.baseUrl || "https://api.anthropic.com");
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": this.config.apiVersion || "2023-06-01"
      };
      if (this.config.authHeader && this.config.apiKey) {
        const prefix = this.config.authScheme ? `${this.config.authScheme} ` : "";
        headers[this.config.authHeader] = `${prefix}${this.config.apiKey}`;
      }

      const system = messages.find((message) => message.role === "system")?.content;
      const filtered = messages.filter((message) => message.role !== "system");
      const anthropicMessages: AnthropicMessage[] = filtered.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content
      }));

      if (!this.config.model) {
        const error = new JPClawError({
          code: ErrorCode.SYSTEM_CONFIG_INVALID,
          message: "Anthropic model is not configured (ANTHROPIC_MODEL).",
          traceId
        });
        logError(error);
        throw error;
      }

      const configuredMaxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS || "1024");
      const maxTokens = Number.isFinite(configuredMaxTokens)
        ? Math.max(configuredMaxTokens, 768)
        : 1024;
      const body = {
        model: this.config.model,
        max_tokens: Number.isFinite(maxTokens) ? maxTokens : 512,
        system,
        messages: anthropicMessages,
        ...(this.config.alwaysThinkingEnabled !== undefined
          ? { alwaysThinkingEnabled: this.config.alwaysThinkingEnabled }
          : {})
      };

      const configuredTimeout = Number(process.env.ANTHROPIC_TIMEOUT_MS || "20000");
      const timeoutMs = Number.isFinite(configuredTimeout) ? Math.max(configuredTimeout, 25000) : 25000;
      const maxAttempts = Number(process.env.ANTHROPIC_RETRY_ATTEMPTS || "2");
      let lastError: unknown;
      let lastAborted = false;
      let response: Response | null = null;
      for (let attempt = 1; attempt <= Math.max(maxAttempts, 1); attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal
          });
          if (!response.ok && response.status >= 500 && attempt < maxAttempts) {
            await sleep(350 * attempt);
            continue;
          }
          break;
        } catch (error) {
          lastError = error;
          lastAborted = error instanceof Error && error.name === "AbortError";
          if (attempt < maxAttempts) {
            log("warn", "provider.anthropic.retry", {
              attempt,
              error: String(error)
            });
            await sleep(350 * attempt);
            continue;
          }
        } finally {
          clearTimeout(timer);
        }
      }

      if (!response) {
        recordMetric("provider.anthropic", { ok: false, durationMs: Date.now() - startedAt, meta: { noResponse: true } });
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }

      if (!response.ok) {
        const errorText = await response.text();
        log("error", "provider.anthropic.error", { status: response.status, body: errorText });
        recordMetric("provider.anthropic", {
          ok: false,
          durationMs: Date.now() - startedAt,
          meta: { status: response.status }
        });
        throw new Error(`Anthropic request failed: ${response.status}`);
      }

      const data = (await response.json()) as AnthropicResponse;
      const text = data.content?.map((item) => item.text).filter(Boolean).join("\n") || "";

      recordMetric("provider.anthropic", { ok: true, durationMs: Date.now() - startedAt, meta: { aborted: lastAborted } });
      return { text, raw: data };
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
