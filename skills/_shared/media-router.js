import fs from "node:fs";
import path from "node:path";

const DEFAULT_BUDGET_MODE = "free_first";
const DEFAULT_QUALITY = "standard";
const VALID_BUDGET_MODES = new Set(["free_first", "quality_first"]);
const VALID_QUALITY = new Set(["standard", "high"]);

function toStr(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeModelKey(model) {
  return toStr(model)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function todayKeyLocal() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function normalizedProvider(input) {
  const raw = toStr(input).trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  if (raw === "google") return "gemini";
  if (raw === "mininglamp" || raw === "mlamp" || raw === "gateway") return "mininglamp";
  return raw;
}

function defaultModel(kind, provider, budgetMode, quality) {
  if (kind === "image") {
    if (provider === "openai") return "gpt-image-1";
    if (provider === "mininglamp") return process.env.MININGLAMP_GATEWAY_IMAGE_MODEL || "gemini-3-pro-image";
    if (provider === "gemini") {
      if (budgetMode === "quality_first") return "gemini-3-pro-image-preview";
      return process.env.GEMINI_FREE_IMAGE_MODEL || "gemini-3-pro-image-preview";
    }
  }
  if (kind === "video") {
    if (provider === "openai") return "sora-2-pro";
    if (provider === "mininglamp") return process.env.MININGLAMP_GATEWAY_VIDEO_MODEL || "gpt-4o";
    if (provider === "gemini") {
      if (budgetMode === "quality_first") return "veo-3.1";
      return process.env.GEMINI_FREE_VIDEO_MODEL || "veo-3.1";
    }
  }
  if (quality === "high") return `${kind}-hq-default`;
  return `${kind}-default`;
}

function pickProvider(kind, budgetMode, provider) {
  if (provider && provider !== "auto") return provider;

  // 优先使用集团网关（如果启用）
  if (process.env.MININGLAMP_GATEWAY_ENABLED === "true") {
    if (kind === "image") {
      const primaryProvider = process.env.MEDIA_IMAGE_PRIMARY_PROVIDER;
      if (primaryProvider === "mininglamp") return "mininglamp";
    }
    if (kind === "video") {
      const primaryProvider = process.env.MEDIA_VIDEO_PRIMARY_PROVIDER;
      if (primaryProvider === "mininglamp") return "mininglamp";
    }
  }

  if (budgetMode === "quality_first") return "openai";
  if (kind === "video") return "gemini";
  return "gemini";
}

function envCostOverride(kind, provider, model, quality) {
  const key = `MEDIA_COST_${kind.toUpperCase()}_${provider.toUpperCase()}_${sanitizeModelKey(model)}_${quality.toUpperCase()}`;
  const value = process.env[key];
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function defaultEstimatedCostUsd(kind, provider, model, quality, budgetMode) {
  const byEnv = envCostOverride(kind, provider, model, quality);
  if (byEnv !== null) return byEnv;

  // 集团网关假设为免费或内部成本
  if (provider === "mininglamp") return 0;

  if (budgetMode === "free_first" && provider === "gemini" && process.env.MEDIA_ASSUME_GEMINI_FREE_FIRST_ZERO !== "false") {
    return 0;
  }

  if (kind === "image") {
    if (provider === "openai" && model === "gpt-image-1") return quality === "high" ? 0.08 : 0.04;
    if (provider === "gemini") return quality === "high" ? 0.03 : 0.01;
    return quality === "high" ? 0.05 : 0.02;
  }

  if (provider === "openai" && model === "sora-2-pro") return quality === "high" ? 1.2 : 0.6;
  if (provider === "gemini" && model.startsWith("veo")) return quality === "high" ? 0.8 : 0.4;
  return quality === "high" ? 0.9 : 0.45;
}

function resolveBudgetLimits() {
  const globalDaily = toNumber(process.env.MEDIA_DAILY_BUDGET_USD, Infinity);
  const imageDaily = toNumber(process.env.MEDIA_IMAGE_DAILY_BUDGET_USD, Infinity);
  const videoDaily = toNumber(process.env.MEDIA_VIDEO_DAILY_BUDGET_USD, Infinity);
  const onExceeded = toStr(process.env.MEDIA_BUDGET_ON_EXCEEDED, "degrade").toLowerCase();
  return {
    globalDaily,
    imageDaily,
    videoDaily,
    onExceeded: onExceeded === "reject" ? "reject" : "degrade"
  };
}

function ledgerPath() {
  return path.resolve(process.cwd(), process.env.MEDIA_BUDGET_LEDGER_PATH || "sessions/media/budget-ledger.json");
}

function readTodayUsage() {
  const filePath = ledgerPath();
  const all = readJson(filePath, {});
  const key = todayKeyLocal();
  const day = all[key] || { all: 0, image: 0, video: 0, entries: [] };
  return { filePath, all, key, day };
}

function checkBudget(kind, estimatedCostUsd) {
  const limits = resolveBudgetLimits();
  const { day } = readTodayUsage();
  const exceeds = [];
  if (day.all + estimatedCostUsd > limits.globalDaily) exceeds.push("global");
  if (kind === "image" && day.image + estimatedCostUsd > limits.imageDaily) exceeds.push("image");
  if (kind === "video" && day.video + estimatedCostUsd > limits.videoDaily) exceeds.push("video");
  return {
    ok: exceeds.length === 0,
    exceeds,
    day,
    limits
  };
}

function freeFallbackRoute(kind, quality) {
  if (kind === "image") {
    return {
      provider: "gemini",
      model: process.env.GEMINI_FREE_IMAGE_MODEL || "gemini-3-pro-image-preview",
      quality: quality === "high" ? "standard" : quality
    };
  }
  return {
    provider: "gemini",
    model: process.env.GEMINI_FREE_VIDEO_MODEL || "veo-3.1",
    quality: quality === "high" ? "standard" : quality
  };
}

function ensureBudgetMode(raw) {
  const mode = toStr(raw, DEFAULT_BUDGET_MODE).toLowerCase();
  return VALID_BUDGET_MODES.has(mode) ? mode : DEFAULT_BUDGET_MODE;
}

function ensureQuality(raw, budgetMode) {
  const normalized = toStr(raw, budgetMode === "quality_first" ? "high" : DEFAULT_QUALITY).toLowerCase();
  return VALID_QUALITY.has(normalized) ? normalized : DEFAULT_QUALITY;
}

export function parseMediaInput(input, kind) {
  const text = toStr(input).trim();
  if (!text) return { task: kind, prompt: "" };
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const payload = JSON.parse(text);
      if (payload && typeof payload === "object") return payload;
    } catch {
      return { task: kind, prompt: text, _parse_error: "invalid_json" };
    }
  }
  return { task: kind, prompt: text };
}

export function resolveMediaRoute(kind, payload) {
  const budgetMode = ensureBudgetMode(payload?.budget_mode);
  const provider = normalizedProvider(payload?.provider);
  const chosenProvider = pickProvider(kind, budgetMode, provider);
  const quality = ensureQuality(payload?.quality, budgetMode);
  const model = toStr(payload?.model) || defaultModel(kind, chosenProvider, budgetMode, quality);

  let route = {
    provider: chosenProvider,
    model,
    quality,
    budget_mode: budgetMode
  };
  route.estimatedCostUsd = defaultEstimatedCostUsd(kind, route.provider, route.model, route.quality, route.budget_mode);

  let budget = checkBudget(kind, route.estimatedCostUsd);
  if (!budget.ok && budget.limits.onExceeded === "degrade") {
    const fallback = freeFallbackRoute(kind, route.quality);
    const downgraded = {
      ...route,
      ...fallback,
      downgradedFrom: {
        provider: route.provider,
        model: route.model,
        quality: route.quality
      }
    };
    downgraded.estimatedCostUsd = defaultEstimatedCostUsd(
      kind,
      downgraded.provider,
      downgraded.model,
      downgraded.quality,
      "free_first"
    );
    const secondBudget = checkBudget(kind, downgraded.estimatedCostUsd);
    if (secondBudget.ok) {
      route = downgraded;
      budget = secondBudget;
    }
  }

  return {
    route,
    budget: {
      ok: budget.ok,
      exceeds: budget.exceeds,
      limits: budget.limits,
      todayUsage: {
        all: budget.day.all,
        image: budget.day.image,
        video: budget.day.video
      }
    }
  };
}

export function commitMediaBudget(kind, route, meta = {}) {
  const estimatedCostUsd = Number(route?.estimatedCostUsd || 0);
  const { filePath, all, key, day } = readTodayUsage();
  const entry = {
    ts: new Date().toISOString(),
    kind,
    provider: route?.provider,
    model: route?.model,
    quality: route?.quality,
    budget_mode: route?.budget_mode,
    estimatedCostUsd,
    ...meta
  };
  const next = {
    all: Number(day.all || 0) + estimatedCostUsd,
    image: Number(day.image || 0) + (kind === "image" ? estimatedCostUsd : 0),
    video: Number(day.video || 0) + (kind === "video" ? estimatedCostUsd : 0),
    entries: [...(Array.isArray(day.entries) ? day.entries : []), entry].slice(-500)
  };
  all[key] = next;
  writeJson(filePath, all);
  return next;
}
