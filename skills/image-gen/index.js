import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commitMediaBudget, parseMediaInput, resolveMediaRoute } from "../_shared/media-router.js";

const execFileAsync = promisify(execFile);

function toStr(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function safePath(value, fallbackName) {
  const fallback = path.resolve(process.cwd(), "sessions", "media", "images", fallbackName);
  if (!value) {
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    return fallback;
  }
  const full = path.resolve(process.cwd(), toStr(value));
  const allowedRoots = [path.resolve(process.cwd(), "sessions"), path.resolve(process.cwd(), "assets")];
  const allowed = allowedRoots.some((root) => full === root || full.startsWith(`${root}${path.sep}`));
  if (!allowed) throw new Error(`Path not allowed: ${value}`);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

function buildAuthHeader() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("missing_OPENAI_API_KEY");
  const headerName = process.env.OPENAI_AUTH_HEADER || "Authorization";
  const scheme = process.env.OPENAI_AUTH_SCHEME || "Bearer";
  const value = headerName.toLowerCase() === "authorization" ? `${scheme} ${key}`.trim() : key;
  return { headerName, value };
}

function clearProxyEnv(env) {
  const keys = [
    "ALL_PROXY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "all_proxy",
    "https_proxy",
    "http_proxy",
    "NO_PROXY",
    "no_proxy"
  ];
  for (const key of keys) {
    delete env[key];
  }
}

function errorWithCause(prefix, error) {
  const cause = error && typeof error === "object" ? error.cause : undefined;
  const causeText = cause ? ` cause=${String(cause)}` : "";
  return new Error(`${prefix}:${String(error)}${causeText}`);
}

function resolveOpenAiProxy(payload) {
  const useProxy = String(payload?.use_proxy ?? process.env.OPENAI_USE_PROXY ?? "true") !== "false";
  if (!useProxy) return null;
  return (
    toStr(payload?.proxy_url) ||
    toStr(process.env.OPENAI_PROXY_URL) ||
    toStr(process.env.HTTPS_PROXY) ||
    toStr(process.env.HTTP_PROXY) ||
    null
  );
}

function resolveGeminiProxy(payload) {
  const useProxy = String(payload?.gemini_use_proxy ?? payload?.use_proxy ?? process.env.GEMINI_USE_PROXY ?? "true") !== "false";
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

function applyProxyEnv(env, proxyUrl) {
  if (!proxyUrl) return;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.HTTPS_PROXY = proxyUrl;
  env.HTTP_PROXY = proxyUrl;
  env.https_proxy = proxyUrl;
  env.http_proxy = proxyUrl;
  if (String(proxyUrl).startsWith("socks")) {
    env.ALL_PROXY = proxyUrl;
    env.all_proxy = proxyUrl;
  }
  env.NODE_USE_ENV_PROXY = env.NODE_USE_ENV_PROXY || "1";
}

async function fetchJsonWithOptionalProxy(url, init, proxyUrl) {
  if (!proxyUrl) {
    const response = await fetch(url, init);
    const data = await response.json().catch(() => ({}));
    return { response, data, viaProxy: false };
  }
  try {
    const { ProxyAgent } = await import("undici");
    const dispatcher = new ProxyAgent(proxyUrl);
    try {
      const response = await fetch(url, { ...init, dispatcher });
      const data = await response.json().catch(() => ({}));
      return { response, data, viaProxy: true, proxyUrl };
    } finally {
      await dispatcher.close();
    }
  } catch (error) {
    throw errorWithCause(`openai_proxy_setup_failed proxy=${proxyUrl}`, error);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
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

function shouldFallback(error) {
  const text = String(error || "").toLowerCase();
  if (text.includes("content_policy") || text.includes("safety")) return false;
  return true;
}

async function runGeminiImage(route, payload, outputPath) {
  const scriptPath = path.resolve(process.cwd(), "skills", "nano-banana-pro", "scripts", "generate_image.py");
  if (!fs.existsSync(scriptPath)) throw new Error(`missing_script:${scriptPath}`);

  const args = [
    "run",
    scriptPath,
    "--prompt",
    toStr(payload.prompt),
    "--filename",
    outputPath,
    "--resolution",
    toStr(payload.resolution || (route.quality === "high" ? "2K" : "1K")),
    "--model",
    route.model
  ];

  const inputImages = Array.isArray(payload.input_images) ? payload.input_images : [];
  for (const imagePath of inputImages) {
    args.push("--input-image", toStr(imagePath));
  }

  if (payload.api_key) {
    args.push("--api-key", toStr(payload.api_key));
  }

  const env = { ...process.env };
  const proxyUrl = resolveGeminiProxy(payload);
  if (proxyUrl) {
    applyProxyEnv(env, proxyUrl);
  } else {
    clearProxyEnv(env);
  }
  if (payload.api_key) env.GEMINI_API_KEY = toStr(payload.api_key);
  const { stdout, stderr } = await execFileAsync("uv", args, { env, maxBuffer: 8 * 1024 * 1024 });
  const mediaLine = toStr(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("MEDIA:"));
  return {
    provider: "gemini",
    model: route.model,
    outputPath: mediaLine ? mediaLine.replace(/^MEDIA:\s*/, "") : outputPath,
    stdout,
    stderr
  };
}

async function runMiningLampImage(route, payload, outputPath) {
  console.log(`[DEBUG] runMiningLampImage called, outputPath: ${outputPath}`);
  const baseUrl = process.env.MININGLAMP_GATEWAY_BASE_URL || "https://llm-guard.mininglamp.com";
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  const apiKey = process.env.MININGLAMP_GATEWAY_API_KEY;
  if (!apiKey) throw new Error("missing_MININGLAMP_GATEWAY_API_KEY");

  const body = {
    model: route.model || "gemini-3-pro-image",
    messages: [
      {
        role: "user",
        content: `Generate an image: ${toStr(payload.prompt)}`
      }
    ],
    max_tokens: 4096
  };

  const timeoutMs = Number(payload.timeout_ms || process.env.OPENAI_IMAGE_TIMEOUT_MS || "60000");
  const useProxy = process.env.MININGLAMP_GATEWAY_USE_PROXY !== "false";
  const proxyUrl = useProxy ? resolveOpenAiProxy(payload) : null;

  let response;
  let json;
  try {
    console.log(`[DEBUG] Sending request to ${endpoint}, timeout: ${timeoutMs}ms`);
    const res = await fetchJsonWithOptionalProxy(
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      },
      proxyUrl
    );
    response = res.response;
    json = res.data;
    console.log(`[DEBUG] Received response: status=${response.status}, ok=${response.ok}`);
  } catch (error) {
    console.log(`[DEBUG] Network error caught: ${error.message}`);
    throw errorWithCause(
      `mininglamp_image_network_error endpoint=${endpoint} timeoutMs=${timeoutMs} proxy=${proxyUrl || "none"}`,
      error
    );
  }

  console.log(`[DEBUG] Checking response.ok: ${response.ok}, status: ${response.status}`);

  // 打印响应体结构（用于调试）
  console.log(`[DEBUG] Response body keys: ${Object.keys(json || {}).join(', ')}`);
  if (json?.choices?.[0]) {
    console.log(`[DEBUG] First choice keys: ${Object.keys(json.choices[0]).join(', ')}`);
  }

  // 不管状态码（包括 408），都尝试从响应中提取图片
  // 目标：只要能拿到图片数据就成功，拿不到才报错
  const message = json?.choices?.[0]?.message;
  console.log(`[DEBUG] Attempting to extract image data, hasMessage: ${!!message}`);

  if (message) {
    console.log(`[DEBUG] Message keys: ${Object.keys(message).join(', ')}`);
    console.log(`[DEBUG] Has image array: ${!!message.image}, Has content: ${!!message.content}`);
  }

  // 方式1：image 数组中的 base64 数据（Gemini 3 Pro Image）
  if (message?.image && Array.isArray(message.image) && message.image.length > 0) {
    console.log(`[DEBUG] Found image array, extracting base64 data...`);
    const imageData = message.image[0].data;
    if (imageData) {
      const bytes = Buffer.from(imageData, "base64");
      fs.writeFileSync(outputPath, bytes);
      const sizeMB = (bytes.length / 1024 / 1024).toFixed(2);
      console.log(`[DEBUG] ✅ Image saved successfully (${sizeMB}MB) to: ${outputPath}`);

      // 如果状态码是 408 但成功提取到了图片，这是正常情况
      if (response.status === 408) {
        console.warn(`⚠️  状态码 408，但成功从响应体中提取到了图片！`);
      }

      return {
        provider: "mininglamp",
        model: route.model,
        outputPath,
        reasoning: message.reasoning_content || null,
        wasTimeout: response.status === 408  // 标记是否从 408 响应中恢复
      };
    }
  }

  // 方式2：content 中包含图像URL
  const content = message?.content;
  if (content) {
    const urlMatch = content.match(/https?:\/\/[^\s]+\.(png|jpg|jpeg|webp)/i);
    if (urlMatch) {
      const imageUrl = urlMatch[0];
      console.log(`[DEBUG] Found image URL in content, downloading: ${imageUrl}`);
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      fs.writeFileSync(outputPath, imageBuffer);
      const sizeMB = (imageBuffer.length / 1024 / 1024).toFixed(2);
      console.log(`[DEBUG] ✅ Image downloaded and saved (${sizeMB}MB) to: ${outputPath}`);

      if (response.status === 408) {
        console.warn(`⚠️  状态码 408，但成功从响应体中提取到了图片 URL！`);
      }

      return {
        provider: "mininglamp",
        model: route.model,
        outputPath,
        imageUrl,
        wasTimeout: response.status === 408
      };
    }

    // 方式3：content 中的 base64 数据
    const base64Match = content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
    if (base64Match) {
      console.log(`[DEBUG] Found base64 image in content, extracting...`);
      const bytes = Buffer.from(base64Match[1], "base64");
      fs.writeFileSync(outputPath, bytes);
      const sizeMB = (bytes.length / 1024 / 1024).toFixed(2);
      console.log(`[DEBUG] ✅ Image saved successfully (${sizeMB}MB) to: ${outputPath}`);

      if (response.status === 408) {
        console.warn(`⚠️  状态码 408，但成功从响应体中提取到了 base64 图片！`);
      }

      return {
        provider: "mininglamp",
        model: route.model,
        outputPath,
        wasTimeout: response.status === 408
      };
    }
  }

  // 如果所有方式都无法提取图片数据，报告详细错误
  console.log(`[DEBUG] ❌ Failed to extract image from all methods`);
  console.log(`[DEBUG] Response body preview: ${JSON.stringify(json).slice(0, 500)}`);

  const errorDetails = {
    status: response.status,
    statusText: response.statusText,
    hasImage: !!message?.image,
    hasContent: !!content,
    responsePreview: JSON.stringify(json).slice(0, 300)
  };
  throw new Error(`mininglamp_image_failed:no_image_data_found status=${response.status} details=${JSON.stringify(errorDetails)}`);
}

async function runOpenAiImage(route, payload, outputPath) {
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com";
  const endpoint = process.env.OPENAI_IMAGE_API_URL || `${baseUrl.replace(/\/+$/, "")}/v1/images/generations`;
  const auth = buildAuthHeader();
  const body = {
    model: route.model,
    prompt: toStr(payload.prompt),
    size: toStr(payload.size || "1024x1024"),
    quality: route.quality,
    n: 1
  };
  const timeoutMs = Number(payload.timeout_ms || process.env.OPENAI_IMAGE_TIMEOUT_MS || "45000");
  const proxyUrl = resolveOpenAiProxy(payload);
  let response;
  let json;
  try {
    const res = await fetchJsonWithOptionalProxy(
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [auth.headerName]: auth.value
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      },
      proxyUrl
    );
    response = res.response;
    json = res.data;
  } catch (error) {
    throw errorWithCause(
      `openai_image_network_error endpoint=${endpoint} timeoutMs=${timeoutMs} proxy=${proxyUrl || "none"}`,
      error
    );
  }
  if (!response.ok) {
    throw new Error(`openai_image_failed:${response.status}:${JSON.stringify(json).slice(0, 400)}`);
  }
  const first = Array.isArray(json?.data) ? json.data[0] : null;
  if (first?.b64_json) {
    const bytes = Buffer.from(first.b64_json, "base64");
    fs.writeFileSync(outputPath, bytes);
    return {
      provider: "openai",
      model: route.model,
      outputPath
    };
  }
  if (first?.url) {
    return {
      provider: "openai",
      model: route.model,
      outputUrl: first.url
    };
  }
  throw new Error("openai_image_failed:missing_image_data");
}

async function runWithRetry(route, payload, outputPath, maxRetries, baseDelayMs) {
  const errors = [];
  for (let i = 0; i <= maxRetries; i += 1) {
    try {
      if (route.provider === "mininglamp") return { result: await runMiningLampImage(route, payload, outputPath), errors };
      if (route.provider === "gemini") return { result: await runGeminiImage(route, payload, outputPath), errors };
      if (route.provider === "openai") return { result: await runOpenAiImage(route, payload, outputPath), errors };
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
    const payload = parseMediaInput(input, "image");
    if (payload._parse_error) {
      return JSON.stringify({ ok: false, error: payload._parse_error }, null, 2);
    }
    if (!toStr(payload.prompt).trim()) {
      return JSON.stringify({ ok: false, error: "missing_prompt" }, null, 2);
    }

    const { route, budget } = resolveMediaRoute("image", payload);
    if (!budget.ok) {
      return JSON.stringify(
        {
          ok: false,
          error: "budget_exceeded",
          budget,
          route
        },
        null,
        2
      );
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = safePath(payload.filename || payload.output_path, `${stamp}-${route.provider}.png`);

    const primaryRetries = Math.max(0, Number(payload.primary_retries ?? process.env.MEDIA_PRIMARY_MAX_RETRIES ?? "1"));
    const fallbackRetries = Math.max(
      0,
      Number(payload.fallback_retries ?? process.env.MEDIA_FALLBACK_MAX_RETRIES ?? "1")
    );
    const retryDelayMs = Math.max(100, Number(payload.retry_delay_ms ?? process.env.MEDIA_RETRY_BACKOFF_MS ?? "1200"));
    const fallbackEnabled = String(payload.enable_fallback ?? process.env.MEDIA_ENABLE_PROVIDER_FALLBACK ?? "true") !== "false";

    let finalRoute = route;
    let result;
    let fallbackInfo = null;
    try {
      const primary = await runWithRetry(route, payload, outputPath, primaryRetries, retryDelayMs);
      result = primary.result;
    } catch (primaryError) {
      if (!fallbackEnabled || !shouldFallback(primaryError)) {
        throw primaryError;
      }
      const fallbackProvider = route.provider === "openai" ? "gemini" : "openai";
      const fallbackPayload = {
        ...payload,
        provider: fallbackProvider,
        model: "",
        budget_mode: "free_first",
        quality: payload.fallback_quality || "standard"
      };
      const fallbackResolved = resolveMediaRoute("image", fallbackPayload);
      if (!fallbackResolved.budget.ok) {
        throw new Error(
          `primary_failed_and_fallback_budget_exceeded primary=${String(primaryError)} fallback=${JSON.stringify(
            fallbackResolved.budget
          )}`
        );
      }
      finalRoute = fallbackResolved.route;
      const fallbackOutputPath =
        finalRoute.provider === route.provider ? outputPath : outputPath.replace(/\.png$/i, `-${finalRoute.provider}.png`);
      try {
        const fallbackRun = await runWithRetry(finalRoute, fallbackPayload, fallbackOutputPath, fallbackRetries, retryDelayMs);
        result = fallbackRun.result;
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

    const usage = commitMediaBudget("image", finalRoute, {
      status: "ok",
      provider: finalRoute.provider,
      model: finalRoute.model
    });

    return JSON.stringify(
      {
        ok: true,
        task: "image",
        route: finalRoute,
        budget,
        fallback: fallbackInfo,
        budgetUsageAfter: { all: usage.all, image: usage.image, video: usage.video },
        result
      },
      null,
      2
    );
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error) }, null, 2);
  }
}
