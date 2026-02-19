/** 迁移自 tests/js/pi-only.spec.ts → Vitest 统一框架 */
import { describe, it, expect } from 'vitest';
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

describe('pi-only', () => {
  it("should gateway is Pi-only (AgentCore removed)", () => {
    const gatewayIndex = path.join(repoRoot, "src/js/gateway/index.ts");
    const content = fs.readFileSync(gatewayIndex, "utf8");

    expect(!content.includes("AgentCore")).toBeTruthy();
    expect(!content.includes("DualEngine")).toBeTruthy();
    expect(!content.includes("EngineRouteMode")).toBeTruthy();

    expect(!fs.existsSync(path.join(repoRoot, "src/js/core/agent.ts"))).toBeTruthy();
    expect(!fs.existsSync(path.join(repoRoot, "src/js/core/dual-engine.ts"))).toBeTruthy();
  });
});
