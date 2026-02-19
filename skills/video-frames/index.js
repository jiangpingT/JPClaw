import { commitMediaBudget, parseMediaInput, resolveMediaRoute } from "../_shared/media-router.js";

function toStr(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function toNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function openAiAuthHeader() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("missing_OPENAI_API_KEY");
  const headerName = process.env.OPENAI_AUTH_HEADER || "Authorization";
  const scheme = process.env.OPENAI_AUTH_SCHEME || "Bearer";
  const value = headerName.toLowerCase() === "authorization" ? `${scheme} ${key}`.trim() : key;
  return { headerName, value };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function toBool(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(normalized);
}

function resolveProviderProxy(provider, payload) {
  if (provider === "openai") {
    const useProxy = toBool(payload?.openai_use_proxy ?? payload?.use_proxy ?? process.env.OPENAI_USE_PROXY, true);
    if (!useProxy) return null;
    return (
      toStr(payload?.openai_proxy_url) ||
      toStr(payload?.proxy_url) ||
      toStr(process.env.OPENAI_PROXY_URL) ||
      toStr(process.env.HTTPS_PROXY) ||
      toStr(process.env.HTTP_PROXY) ||
      null
    );
  }
  const useProxy = toBool(payload?.gemini_use_proxy ?? payload?.use_proxy ?? process.env.GEMINI_USE_PROXY, true);
  if (!useProxy) return null;
  return (
    toStr(payload?.gemini_proxy_url) ||
    toStr(payload?.proxy_url) ||
    toStr(process.env.GEMINI_PROXY_URL) ||
    toStr(process.env.HTTPS_PROXY) ||
    toStr(process.env.HTTP_PROXY) ||
    null
  );
}

async function fetchJsonWithOptionalProxy(url, init, proxyUrl) {
  if (!proxyUrl) {
    const response = await fetch(url, init);
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }
  const { ProxyAgent } = await import("undici");
  const dispatcher = new ProxyAgent(proxyUrl);
  try {
    const response = await fetch(url, { ...init, dispatcher });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    await dispatcher.close();
  }
}

function isRetriableError(error) {
  const text = String(error || "").toLowerCase();
  return (
    text.includes("timeout") ||
    text.includes("fetch failed") ||
    text.includes("connect") ||
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("resource_exhausted") ||
    text.includes("quota") ||
    text.includes("5xx") ||
    text.includes("502") ||
    text.includes("503") ||
    text.includes("504")
  );
}

async function callOpenAiVideo(route, payload) {
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com";
  const endpoint = process.env.OPENAI_VIDEO_API_URL || `${baseUrl.replace(/\/+$/, "")}/v1/videos`;
  const auth = openAiAuthHeader();
  const body = {
    model: route.model,
    prompt: toStr(payload.prompt),
    quality: route.quality,
    duration_seconds: toNum(payload.duration_seconds, 8),
    aspect_ratio: toStr(payload.aspect_ratio || "16:9")
  };
  const proxyUrl = resolveProviderProxy("openai", payload);
  const { response, data } = await fetchJsonWithOptionalProxy(
    endpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [auth.headerName]: auth.value
      },
      body: JSON.stringify(body)
    },
    proxyUrl
  );
  if (!response.ok) {
    throw new Error(`openai_video_failed:${response.status}:${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

async function callMiningLampVideo(route, payload) {
  const baseUrl = process.env.MININGLAMP_GATEWAY_BASE_URL || "https://llm-guard.mininglamp.com";
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  const apiKey = process.env.MININGLAMP_GATEWAY_API_KEY;
  if (!apiKey) throw new Error("missing_MININGLAMP_GATEWAY_API_KEY");

  const body = {
    model: route.model || "gpt-4o",
    messages: [
      {
        role: "user",
        content: `Generate a video: ${toStr(payload.prompt)}. Duration: ${toNum(payload.duration_seconds, 8)}s, Aspect ratio: ${toStr(payload.aspect_ratio || "16:9")}`
      }
    ],
    max_tokens: 4096
  };

  const timeoutMs = Number(payload.timeout_ms || process.env.OPENAI_VIDEO_TIMEOUT_MS || "120000");
  const useProxy = process.env.MININGLAMP_GATEWAY_USE_PROXY !== "false";
  const proxyUrl = useProxy ? resolveProviderProxy("openai", payload) : null;

  const { response, data } = await fetchJsonWithOptionalProxy(
    endpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    },
    proxyUrl
  );

  if (!response.ok) {
    throw new Error(`mininglamp_video_failed:${response.status}:${JSON.stringify(data).slice(0, 500)}`);
  }

  // 集团网关的 gpt-4o 视频响应格式
  const message = data?.choices?.[0]?.message;

  // 方式1：video 数组中的数据
  if (message?.video && Array.isArray(message.video) && message.video.length > 0) {
    return {
      provider: "mininglamp",
      model: route.model,
      video: message.video[0],
      reasoning: message.reasoning_content || null
    };
  }

  // 方式2：content 中包含视频URL
  const content = message?.content;
  if (content) {
    const urlMatch = content.match(/https?:\/\/[^\s]+\.(mp4|webm|mov)/i);
    if (urlMatch) {
      return {
        provider: "mininglamp",
        model: route.model,
        videoUrl: urlMatch[0],
        content
      };
    }
  }

  // 方式3：直接返回message内容供后续处理
  if (message) {
    return {
      provider: "mininglamp",
      model: route.model,
      message
    };
  }

  throw new Error(`mininglamp_video_failed:unexpected_response_format hasVideo=${!!message?.video} hasContent=${!!content}`);
}

async function callGeminiVideo(route, payload) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("missing_GEMINI_API_KEY");
  const endpointBase =
    process.env.GEMINI_VIDEO_API_URL ||
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(route.model)}:generateVideo`;
  const endpoint = endpointBase.includes("?") ? `${endpointBase}&key=${encodeURIComponent(apiKey)}` : `${endpointBase}?key=${encodeURIComponent(apiKey)}`;
  const body = {
    prompt: toStr(payload.prompt),
    config: {
      quality: route.quality,
      durationSeconds: toNum(payload.duration_seconds, 8),
      aspectRatio: toStr(payload.aspect_ratio || "16:9")
    }
  };
  const proxyUrl = resolveProviderProxy("gemini", payload);
  const { response, data } = await fetchJsonWithOptionalProxy(
    endpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    },
    proxyUrl
  );
  if (!response.ok) {
    throw new Error(`gemini_video_failed:${response.status}:${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

async function runWithRetry(route, payload, maxRetries, baseDelayMs) {
  const errors = [];
  for (let i = 0; i <= maxRetries; i += 1) {
    try {
      if (route.provider === "mininglamp") return { result: await callMiningLampVideo(route, payload), errors };
      if (route.provider === "openai") return { result: await callOpenAiVideo(route, payload), errors };
      if (route.provider === "gemini") return { result: await callGeminiVideo(route, payload), errors };
      throw new Error(`unsupported_provider:${route.provider}`);
    } catch (error) {
      errors.push(String(error));
      if (i >= maxRetries || !isRetriableError(error)) {
        throw Object.assign(new Error(String(error)), { attempts: i + 1, errors });
      }
      await sleep(baseDelayMs * Math.max(1, i + 1));
    }
  }
  throw new Error("unreachable");
}

export async function run(input) {
  try {
    const payload = parseMediaInput(input, "video");
    if (payload._parse_error) {
      return JSON.stringify({ ok: false, error: payload._parse_error }, null, 2);
    }
    if (!toStr(payload.prompt).trim()) {
      return JSON.stringify({ ok: false, error: "missing_prompt" }, null, 2);
    }

    const { route, budget } = resolveMediaRoute("video", payload);
    if (!budget.ok) {
      return JSON.stringify({ ok: false, error: "budget_exceeded", route, budget }, null, 2);
    }

    const primaryRetries = Math.max(0, Number(payload.primary_retries ?? process.env.MEDIA_PRIMARY_MAX_RETRIES ?? "1"));
    const fallbackRetries = Math.max(
      0,
      Number(payload.fallback_retries ?? process.env.MEDIA_FALLBACK_MAX_RETRIES ?? "1")
    );
    const retryDelayMs = Math.max(100, Number(payload.retry_delay_ms ?? process.env.MEDIA_RETRY_BACKOFF_MS ?? "1200"));
    const fallbackEnabled = String(payload.enable_fallback ?? process.env.MEDIA_ENABLE_PROVIDER_FALLBACK ?? "true") !== "false";

    let finalRoute = route;
    let vendorResult;
    let fallbackInfo = null;
    try {
      const primary = await runWithRetry(route, payload, primaryRetries, retryDelayMs);
      vendorResult = primary.result;
    } catch (primaryError) {
      if (!fallbackEnabled) throw primaryError;
      const fallbackProvider = route.provider === "openai" ? "gemini" : "openai";
      const fallbackPayload = {
        ...payload,
        provider: fallbackProvider,
        model: "",
        budget_mode: "free_first",
        quality: payload.fallback_quality || "standard"
      };
      const fallbackResolved = resolveMediaRoute("video", fallbackPayload);
      if (!fallbackResolved.budget.ok) {
        throw new Error(
          `primary_failed_and_fallback_budget_exceeded primary=${String(primaryError)} fallback=${JSON.stringify(
            fallbackResolved.budget
          )}`
        );
      }
      finalRoute = fallbackResolved.route;
      try {
        const fallbackRun = await runWithRetry(finalRoute, fallbackPayload, fallbackRetries, retryDelayMs);
        vendorResult = fallbackRun.result;
        fallbackInfo = {
          enabled: true,
          primaryProvider: route.provider,
          fallbackProvider: finalRoute.provider,
          primaryError: String(primaryError)
        };
      } catch (fallbackError) {
        throw new Error(`primary_error=${String(primaryError)}; fallback_error=${String(fallbackError)}`);
      }
    }

    const usage = commitMediaBudget("video", finalRoute, {
      status: "ok",
      provider: finalRoute.provider,
      model: finalRoute.model
    });

    return JSON.stringify(
      {
        ok: true,
        task: "video",
        route: finalRoute,
        budget,
        fallback: fallbackInfo,
        budgetUsageAfter: { all: usage.all, image: usage.image, video: usage.video },
        result: vendorResult
      },
      null,
      2
    );
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error) }, null, 2);
  }
}
