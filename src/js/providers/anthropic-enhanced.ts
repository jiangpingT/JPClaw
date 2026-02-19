import type { AgentMessage } from "../core/messages.js";
import type { Provider, ProviderResponse } from "./types.js";
import type { ProviderConfig } from "../shared/config.js";
import { logError, logMetric } from "../shared/logger.js";
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

      if (traceId) {
        span.setMetadata("traceId", traceId);
      }

      const startedAt = Date.now();

      try {
        // 配置验证
        if (!this.config.model) {
          throw new JPClawError({
            code: ErrorCode.SYSTEM_CONFIG_INVALID,
            message: "Anthropic model is not configured (ANTHROPIC_MODEL).",
            traceId
          });
        }

        if (!this.config.apiKey) {
          throw new JPClawError({
            code: ErrorCode.SYSTEM_CONFIG_INVALID,
            message: "Anthropic API key is not configured.",
            traceId
          });
        }

        // 构建请求
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

        span.setMetadata("requestBody", {
          model: body.model,
          maxTokens: body.max_tokens,
          messageCount: anthropicMessages.length
        });

        // 重试配置
        const configuredTimeout = Number(process.env.ANTHROPIC_TIMEOUT_MS || "20000");
        const timeoutMs = Number.isFinite(configuredTimeout) ? Math.max(configuredTimeout, 25000) : 25000;
        const maxAttempts = Number(process.env.ANTHROPIC_RETRY_ATTEMPTS || "2");

        let lastError: unknown;
        let lastAborted = false;
        let response: Response | null = null;

        // 重试逻辑
        for (let attempt = 1; attempt <= Math.max(maxAttempts, 1); attempt += 1) {
          const attemptSpan = span.createChild(`anthropic.generate.attempt_${attempt}`);
          attemptSpan.setTag("attempt", attempt.toString());

          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            try {
              response = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal: controller.signal
              });

              attemptSpan.setTag("http.status_code", response.status.toString());

              if (!response.ok && response.status >= 500 && attempt < maxAttempts) {
                attemptSpan.setError(`HTTP ${response.status} - retrying`);
                attemptSpan.finish(false);
                await sleep(350 * attempt);
                continue;
              }

              attemptSpan.finish(response.ok);
              break;

            } finally {
              clearTimeout(timer);
            }

          } catch (error) {
            lastError = error;
            lastAborted = error instanceof Error && error.name === "AbortError";
            
            attemptSpan.setError(error instanceof Error ? error : String(error));
            attemptSpan.finish(false);

            if (attempt < maxAttempts) {
              logMetric("anthropic.retry", attempt, "count", { 
                error: String(error),
                aborted: lastAborted.toString()
              });
              await sleep(350 * attempt);
              continue;
            }
          }
        }

        // 处理响应
        if (!response) {
          const error = lastAborted 
            ? new JPClawError({
                code: ErrorCode.PROVIDER_TIMEOUT,
                message: "Anthropic request timed out",
                context: { timeoutMs, maxAttempts },
                traceId
              })
            : new JPClawError({
                code: ErrorCode.PROVIDER_UNAVAILABLE,
                message: "Anthropic service unavailable",
                context: { lastError: String(lastError), maxAttempts },
                traceId,
                cause: lastError instanceof Error ? lastError : undefined
              });

          logError(error, { provider: "anthropic" });
          span.setError(error.message);
          
          recordMetric("provider.anthropic", { 
            ok: false, 
            durationMs: Date.now() - startedAt, 
            meta: { noResponse: true, aborted: lastAborted } 
          });
          
          throw error;
        }

        if (!response.ok) {
          let errorText = "Unknown error";
          try {
            errorText = await response.text();
          } catch {
            // ignore
          }

          const error = this.createHttpError(response.status, errorText, traceId);
          logError(error, { provider: "anthropic", httpStatus: response.status });
          span.setError(`HTTP ${response.status}: ${errorText}`);
          
          recordMetric("provider.anthropic", {
            ok: false,
            durationMs: Date.now() - startedAt,
            meta: { status: response.status }
          });
          
          throw error;
        }

        // 解析响应
        let data: AnthropicResponse;
        try {
          data = await response.json() as AnthropicResponse;
        } catch (parseError) {
          const error = new JPClawError({
            code: ErrorCode.PROVIDER_INVALID_RESPONSE,
            message: "Failed to parse Anthropic response",
            context: { parseError: String(parseError) },
            traceId,
            cause: parseError instanceof Error ? parseError : undefined
          });
          
          logError(error, { provider: "anthropic" });
          span.setError("Invalid JSON response");
          throw error;
        }

        const text = data.content?.map((item) => item.text).filter(Boolean).join("\n") || "";
        
        if (!text.trim()) {
          const error = new JPClawError({
            code: ErrorCode.PROVIDER_INVALID_RESPONSE,
            message: "Anthropic returned empty response",
            context: { responseContent: data },
            traceId
          });
          
          logError(error, { provider: "anthropic" });
          span.setError("Empty response");
          throw error;
        }

        // 成功指标
        const duration = Date.now() - startedAt;
        recordMetric("provider.anthropic", { 
          ok: true, 
          durationMs: duration,
          meta: { 
            aborted: lastAborted,
            textLength: text.length,
            model: this.config.model
          } 
        });

        logMetric("anthropic.response_time", duration, "ms", {
          model: this.config.model || "unknown",
          success: "true"
        });

        span.setTags({
          "response.length": text.length.toString(),
          "success": "true"
        });

        return { text, raw: data };

      } catch (error) {
        if (error instanceof JPClawError) {
          throw error;
        }

        const wrappedError = new JPClawError({
          code: ErrorCode.PROVIDER_UNAVAILABLE,
          message: `Anthropic provider error: ${error instanceof Error ? error.message : String(error)}`,
          context: { originalError: String(error) },
          traceId,
          cause: error instanceof Error ? error : undefined
        });

        logError(wrappedError, { provider: "anthropic" });
        span.setError(wrappedError.message);
        throw wrappedError;
      }
    });
  }

  private createHttpError(status: number, body: string, traceId?: string): JPClawError {
    if (status === 401 || status === 403) {
      return new JPClawError({
        code: ErrorCode.AUTH_INVALID_TOKEN,
        message: `Anthropic authentication failed (${status})`,
        context: { httpStatus: status, responseBody: body },
        traceId
      });
    }

    if (status === 429) {
      return new JPClawError({
        code: ErrorCode.AUTH_RATE_LIMITED,
        message: "Anthropic rate limit exceeded",
        context: { httpStatus: status, responseBody: body },
        traceId
      });
    }

    if (status === 402 || body.includes("quota") || body.includes("billing")) {
      return new JPClawError({
        code: ErrorCode.PROVIDER_QUOTA_EXCEEDED,
        message: "Anthropic quota exceeded",
        context: { httpStatus: status, responseBody: body },
        traceId
      });
    }

    if (status >= 500) {
      return new JPClawError({
        code: ErrorCode.PROVIDER_UNAVAILABLE,
        message: `Anthropic server error (${status})`,
        context: { httpStatus: status, responseBody: body },
        traceId
      });
    }

    return new JPClawError({
      code: ErrorCode.INPUT_VALIDATION_FAILED,
      message: `Anthropic client error (${status})`,
      context: { httpStatus: status, responseBody: body },
      traceId
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}