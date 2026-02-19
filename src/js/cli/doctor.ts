import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { exec } from "node:child_process";
import { loadConfig } from "../shared/config.js";

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

export async function runDoctor(): Promise<number> {
  const config = loadConfig();
  const checks: CheckResult[] = [];

  checks.push(checkAdmins());
  checks.push(checkDiscordToken());
  checks.push(checkAnthropicConfig());
  checks.push(checkMemoryDir());
  checks.push(await checkGatewayHealth(config.gateway.host, config.gateway.port));
  checks.push(await checkLaunchdService());

  const failed = checks.filter((x) => !x.ok);
  for (const item of checks) {
    const mark = item.ok ? "OK" : "FAIL";
    console.log(`[${mark}] ${item.name} - ${item.detail}`);
  }
  console.log(`\nDoctor summary: ${checks.length - failed.length}/${checks.length} passed`);
  return failed.length === 0 ? 0 : 1;
}

function checkAdmins(): CheckResult {
  const admins = (process.env.DISCORD_ADMIN_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    name: "DISCORD_ADMIN_IDS",
    ok: admins.length >= 1,
    detail: admins.length >= 1 ? `configured (${admins.length} ids)` : "missing"
  };
}

function checkDiscordToken(): CheckResult {
  const token = process.env.DISCORD_BOT_TOKEN || "";
  return {
    name: "DISCORD_BOT_TOKEN",
    ok: token.length > 30,
    detail: token.length > 30 ? "configured" : "missing_or_too_short"
  };
}

function checkAnthropicConfig(): CheckResult {
  const token = process.env.ANTHROPIC_AUTH_TOKEN || "";
  const base = process.env.ANTHROPIC_BASE_URL || "";
  const ok = token.length > 20 && base.startsWith("http");
  return {
    name: "Anthropic Provider",
    ok,
    detail: ok ? "configured" : "missing_token_or_base_url"
  };
}

function checkMemoryDir(): CheckResult {
  const dir = path.resolve(process.cwd(), "sessions", "memory", "users");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".doctor_probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return { name: "Memory Dir", ok: true, detail: dir };
  } catch (error) {
    return { name: "Memory Dir", ok: false, detail: String(error) };
  }
}

async function checkGatewayHealth(host: string, port: number): Promise<CheckResult> {
  const url = `http://${host}:${port}/health`;
  try {
    const body = await httpGet(url, 2500);
    const ok = body.includes('"ok":true') || body.includes('"ok": true');
    return {
      name: "Gateway /health",
      ok,
      detail: ok ? url : `reachable but unhealthy: ${url}`
    };
  } catch (error) {
    return {
      name: "Gateway /health",
      ok: false,
      detail: `${url} (${String(error)})`
    };
  }
}

async function checkLaunchdService(): Promise<CheckResult> {
  const cmd = "launchctl print gui/$(id -u)/com.jpclaw.gateway";
  try {
    const output = await runCommand(cmd);
    const ok = output.includes("state = running") || output.includes("active count = 1");
    return {
      name: "launchd com.jpclaw.gateway",
      ok,
      detail: ok ? "running" : "installed but not running"
    };
  } catch (error) {
    return {
      name: "launchd com.jpclaw.gateway",
      ok: false,
      detail: `not available (${String(error)})`
    };
  }
}

function httpGet(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        resolve(body);
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
  });
}

function runCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        timeout: 5000,
        maxBuffer: 512 * 1024,
        env: process.env,
        shell: "/bin/zsh"
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || stdout || error.message).trim()));
          return;
        }
        resolve(stdout);
      }
    );
  });
}
