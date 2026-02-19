import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

function parseInput(raw) {
  if (!raw) return {};
  const text = String(raw).trim();
  if (!text) return {};
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return { url: text };
    }
  }
  return { url: text };
}

function pickFirstMatch(text, patterns) {
  for (const pattern of patterns) {
    const re = new RegExp(`([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(万|k|K|m|M)?\\s*${pattern}`);
    const m = text.match(re);
    if (m?.[1]) return parseCompactNumber(m[1], m[2]);
  }
  return null;
}

function parseCompactNumber(raw, unit) {
  const cleaned = String(raw || "").replace(/,/g, "");
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  const u = String(unit || "").toLowerCase();
  if (u === "万") return Math.round(num * 10000);
  if (u === "k") return Math.round(num * 1000);
  if (u === "m") return Math.round(num * 1000000);
  return Math.round(num);
}

function looksLikeLoginWall(text) {
  const lower = String(text || "").toLowerCase();
  return (
    lower.includes("扫码") ||
    lower.includes("scan") ||
    lower.includes("login") ||
    lower.includes("sign in") ||
    lower.includes("验证码")
  );
}

function hasAnyCount(counts) {
  return Object.values(counts || {}).some((v) => v !== null && v !== undefined);
}

function buildLabels(custom) {
  const defaults = {
    followers: ["被关注", "粉丝", "关注者"],
    following: ["关注"],
    likes: ["赞", "点赞"],
    comments: ["评论"],
    praises: ["夸夸"]
  };
  if (!custom || typeof custom !== "object") return defaults;
  const merged = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (Array.isArray(custom[key]) && custom[key].length > 0) {
      merged[key] = custom[key].map(String);
    }
  }
  return merged;
}

export async function run(input) {
  const baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const cwd = process.cwd();
  if (cwd !== baseDir) {
    process.chdir(baseDir);
  }
  const payload = parseInput(input);
  const url = payload.url;
  if (!url) return JSON.stringify({ ok: false, error: "missing_url" }, null, 2);

  const labels = buildLabels(payload.labels);
  const storageStatePath = payload.storageStatePath;
  const timeoutMs = Number(payload.timeoutMs || 30000);
  const interactiveLogin = payload.interactiveLogin !== false;
  const loginTimeoutMs = Number(payload.loginTimeoutMs || 180000);

  const browserPayload = {
    url,
    headless: true,
    timeoutMs,
    storageStatePath,
    actions: [
      { type: "wait_for", selector: "body" },
      { type: "wait", ms: 800 },
      { type: "extract", selector: "body", maxChars: 6000 }
    ]
  };

  const browserEntry = path.resolve(baseDir, "skills", "browser-automation", "index.js");
  const { run: runBrowser } = await import(pathToFileURL(browserEntry).href);
  const output = await runBrowser(JSON.stringify(browserPayload));
  let extractedText = "";
  try {
    const parsed = JSON.parse(output);
    extractedText = String(parsed?.extractedText || "");
  } catch {
    return JSON.stringify({ ok: false, error: "extract_failed", details: output }, null, 2);
  }

  const counts = {
    followers: pickFirstMatch(extractedText, labels.followers),
    following: pickFirstMatch(extractedText, labels.following),
    likes: pickFirstMatch(extractedText, labels.likes),
    comments: pickFirstMatch(extractedText, labels.comments),
    praises: pickFirstMatch(extractedText, labels.praises)
  };

  if (!hasAnyCount(counts) && interactiveLogin && storageStatePath && looksLikeLoginWall(extractedText)) {
    const loginPayload = {
      url,
      headless: false,
      timeoutMs: loginTimeoutMs,
      storageStatePath,
      saveStorageStatePath: storageStatePath,
      actions: [
        { type: "wait_for", selector: "body" },
        {
          type: "wait_for_any_text",
          texts: [...labels.followers, ...labels.following],
          timeoutMs: loginTimeoutMs
        },
        { type: "wait", ms: 800 },
        { type: "extract", selector: "body", maxChars: 6000 }
      ]
    };
    const loginOut = await runBrowser(JSON.stringify(loginPayload));
    try {
      const parsed = JSON.parse(loginOut);
      extractedText = String(parsed?.extractedText || extractedText);
    } catch {
      // keep old
    }
    const counts2 = {
      followers: pickFirstMatch(extractedText, labels.followers),
      following: pickFirstMatch(extractedText, labels.following),
      likes: pickFirstMatch(extractedText, labels.likes),
      comments: pickFirstMatch(extractedText, labels.comments),
      praises: pickFirstMatch(extractedText, labels.praises)
    };
    if (hasAnyCount(counts2)) {
      const payloadHash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 8);
      return JSON.stringify(
        {
          ok: true,
          url,
          counts: counts2,
          textSample: extractedText.slice(0, 800),
          fetchedAt: new Date().toISOString(),
          trace: payloadHash,
          login: "interactive_saved"
        },
        null,
        2
      );
    }
  }

  const payloadHash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 8);
  return JSON.stringify(
    {
      ok: true,
      url,
      counts,
      textSample: extractedText.slice(0, 800),
      fetchedAt: new Date().toISOString(),
      trace: payloadHash
    },
    null,
    2
  );
}
