import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function parseInput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return { action: "help" };
    }
  }
  return { action: "help", raw: text };
}

function ensureAllowedPath(value) {
  if (!value) return null;
  const full = path.resolve(process.cwd(), value);
  const roots = [path.resolve(process.cwd(), "sessions"), path.resolve(process.cwd(), "assets")];
  const ok = roots.some((r) => full.startsWith(r + path.sep) || full === r);
  if (!ok) throw new Error(`Path not allowed: ${value}`);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

function defaultPolicy() {
  return {
    allowStdio: false,
    allowRemoteUrl: false,
    allowServers: ["*"],
    denyServers: ["filesystem", "shell", "terminal", "exec"],
    maxOutputChars: 20000
  };
}

function loadPolicy(policyPath) {
  const full = ensureAllowedPath(policyPath || "sessions/mcp/policy.json");
  if (!fs.existsSync(full)) {
    return { policy: defaultPolicy(), path: full, existed: false };
  }
  try {
    const json = JSON.parse(fs.readFileSync(full, "utf-8"));
    return { policy: { ...defaultPolicy(), ...(json || {}) }, path: full, existed: true };
  } catch {
    return { policy: defaultPolicy(), path: full, existed: true };
  }
}

function checkSelector(selector, policy) {
  const s = String(selector || "").trim();
  if (!s) return { ok: false, error: "missing_selector" };
  if (s.startsWith("http://") || s.startsWith("https://")) {
    if (!policy.allowRemoteUrl) return { ok: false, error: "remote_url_not_allowed" };
    return { ok: true };
  }
  if (s.startsWith("stdio:")) {
    if (!policy.allowStdio) return { ok: false, error: "stdio_not_allowed" };
    return { ok: true };
  }
  const server = s.includes(".") ? s.split(".")[0] : s;
  const deny = Array.isArray(policy.denyServers) ? policy.denyServers.map(String) : [];
  if (deny.includes(server)) return { ok: false, error: `server_denied:${server}` };
  const allow = Array.isArray(policy.allowServers) ? policy.allowServers.map(String) : ["*"];
  if (!(allow.includes("*") || allow.includes(server))) return { ok: false, error: `server_not_allowed:${server}` };
  return { ok: true };
}

function runCmd(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("mcporter", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, Math.max(1000, Number(timeoutMs || 20000)));
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: Number(code || 0), stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(err?.message || err) });
    });
  });
}

export async function run(input) {
  const payload = parseInput(input);
  const action = String(payload.action || "help").toLowerCase();
  const timeoutMs = Number(payload.timeoutMs || 25000);
  const { policy, path: policyPath, existed } = loadPolicy(payload.policyPath);

  if (action === "help") {
    return JSON.stringify(
      {
        ok: true,
        action: "help",
        examples: [
          { action: "doctor" },
          { action: "policy_init" },
          { action: "list" },
          { action: "list", server: "linear", schema: true },
          { action: "call", selector: "linear.list_issues", args: { team: "ENG", limit: 5 } }
        ],
        policyPath
      },
      null,
      2
    );
  }

  if (action === "policy_init") {
    const full = ensureAllowedPath(payload.policyPath || "sessions/mcp/policy.json");
    if (!fs.existsSync(full)) {
      fs.writeFileSync(full, JSON.stringify(defaultPolicy(), null, 2));
    }
    return JSON.stringify({ ok: true, action, policyPath: full }, null, 2);
  }

  if (action === "doctor") {
    const version = await runCmd(["--version"], timeoutMs);
    const list = await runCmd(["list"], timeoutMs);
    const maxOutputChars = Math.max(500, Number(policy.maxOutputChars || 20000));
    return JSON.stringify(
      {
        ok: version.code === 0,
        action,
        policyPath,
        policyExisted: existed,
        version: version.stdout.trim() || version.stderr.trim(),
        listPreview: (list.stdout || list.stderr).slice(0, maxOutputChars)
      },
      null,
      2
    );
  }

  if (action === "list") {
    const args = ["list"];
    if (payload.server) args.push(String(payload.server));
    if (payload.schema) args.push("--schema");
    const out = await runCmd(args, timeoutMs);
    const maxOutputChars = Math.max(500, Number(policy.maxOutputChars || 20000));
    return JSON.stringify(
      {
        ok: out.code === 0,
        action,
        policyPath,
        code: out.code,
        stdout: out.stdout.slice(0, maxOutputChars),
        stderr: out.stderr.slice(0, maxOutputChars)
      },
      null,
      2
    );
  }

  if (action === "call") {
    const selector = String(payload.selector || "").trim();
    const checked = checkSelector(selector, policy);
    if (!checked.ok) {
      return JSON.stringify({ ok: false, action, error: checked.error, policyPath }, null, 2);
    }
    const args = ["call", selector];
    if (payload.args && typeof payload.args === "object") {
      args.push("--args", JSON.stringify(payload.args));
    } else if (payload.argsJson) {
      args.push("--args", String(payload.argsJson));
    }
    const out = await runCmd(args, timeoutMs);
    const maxOutputChars = Math.max(500, Number(policy.maxOutputChars || 20000));
    return JSON.stringify(
      {
        ok: out.code === 0,
        action,
        selector,
        policyPath,
        code: out.code,
        stdout: out.stdout.slice(0, maxOutputChars),
        stderr: out.stderr.slice(0, maxOutputChars)
      },
      null,
      2
    );
  }

  return JSON.stringify({ ok: false, error: "unsupported_action", action }, null, 2);
}
