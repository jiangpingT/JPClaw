/** 迁移自 tests/js/config.spec.ts → Vitest 统一框架 */
import { describe, it, expect } from 'vitest';
import { loadConfig } from "../../src/js/shared/config.js";

describe('config', () => {
  it("should loadConfig merges provider env vars without dotenv", () => {
    process.env.JPCLAW_SKIP_DOTENV = "true";
    process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
    process.env.ANTHROPIC_BASE_URL = "https://example.test";
    process.env.ANTHROPIC_AUTH_HEADER = "x-api-key";
    process.env.ANTHROPIC_MODEL = "test-model";
    process.env.ANTHROPIC_ALWAYS_THINKING = "true";

    const config = loadConfig();
    const provider = config.providers.find((item) => item.type === "anthropic");

    expect(provider).toBeTruthy();
    expect(provider?.apiKey).toBe("test-token");
    expect(provider?.baseUrl).toBe("https://example.test");
    expect(provider?.authHeader).toBe("x-api-key");
    expect(provider?.model).toBe("test-model");
    expect(provider?.alwaysThinkingEnabled).toBe(true);

    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_HEADER;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_ALWAYS_THINKING;
    delete process.env.JPCLAW_SKIP_DOTENV;
  });
});
