import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";

function parseInput(raw) {
  if (!raw) return {};
  const text = String(raw).trim();
  if (!text) return {};
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return { __parseError: "invalid_json" };
    }
  }
  return { url: text };
}

function ensureAllowedPath(value) {
  if (!value) return null;
  const full = path.resolve(process.cwd(), value);
  const allowed = [
    path.resolve(process.cwd(), "sessions"),
    path.resolve(process.cwd(), "assets")
  ];
  const ok = allowed.some((dir) => full.startsWith(dir + path.sep) || full === dir);
  if (!ok) throw new Error(`Path not allowed: ${value}`);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

function toStr(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function clampText(value, maxChars) {
  const s = toStr(value);
  const n = Number(maxChars || 0);
  if (!Number.isFinite(n) || n <= 0) return s;
  return s.slice(0, n);
}

async function safeEval(page, fn, arg) {
  return page.evaluate(fn, arg);
}

function normalizeText(input) {
  return toStr(input).replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function applyTextTransforms(text, transforms) {
  let out = toStr(text);
  const list = Array.isArray(transforms) ? transforms : [];
  for (const t of list) {
    const kind = String(t?.type || "").toLowerCase();
    if (kind === "normalize") {
      out = normalizeText(out);
      continue;
    }
    if (kind === "replace_regex") {
      const pattern = toStr(t?.pattern);
      if (!pattern) continue;
      const flags = toStr(t?.flags || "g");
      const replacement = toStr(t?.replacement || "");
      try {
        out = out.replace(new RegExp(pattern, flags), replacement);
      } catch {
        // ignore invalid regex
      }
      continue;
    }
    if (kind === "slice") {
      const start = Number(t?.start || 0);
      const end = t?.end === undefined ? undefined : Number(t?.end);
      out = out.slice(start, end);
      continue;
    }
  }
  return out;
}

function pickSourceText(result) {
  if (toStr(result?.extractedText)) return toStr(result.extractedText);
  if (toStr(result?.html)) return toStr(result.html);
  return "";
}

function matchesUrlRule(url, rule) {
  if (!rule) return true;
  const target = toStr(url);
  const maybeRegex = toStr(rule.regex);
  if (maybeRegex) {
    try {
      const re = new RegExp(maybeRegex, toStr(rule.flags || ""));
      return re.test(target);
    } catch {
      return false;
    }
  }
  const contains = toStr(rule.contains);
  if (contains) return target.includes(contains);
  const equals = toStr(rule.equals);
  if (equals) return target === equals;
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function buildErrorScreenshotPath(dir, traceId, runAttempt, stepIndex, actionType, retryIndex) {
  const safeType = toStr(actionType || "unknown").replace(/[^a-zA-Z0-9_-]+/g, "_");
  const retryPart = retryIndex > 1 ? `-retry${retryIndex}` : "";
  return path.join(
    toStr(dir || "sessions/screens/errors"),
    `${traceId}-run${runAttempt}-step${stepIndex}-${safeType}${retryPart}.png`
  );
}

export async function run(input) {
  const payload = parseInput(input);
  if (payload.__parseError) {
    return JSON.stringify({ ok: false, error: payload.__parseError }, null, 2);
  }
  const url = payload.url;
  if (!url) return JSON.stringify({ ok: false, error: "missing_url" }, null, 2);

  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const timeoutMs = Number(payload.timeoutMs || 15000);
  const initialHeadless = payload.headless !== false;
  const autoFallbackHeadful = payload.autoFallbackHeadful !== false;
  const runRetryTimes = Math.max(0, Number(payload.runRetryTimes || 0));
  const actionRetryTimesDefault = Math.max(0, Number(payload.actionRetryTimes || 0));
  const actionRetryDelayMsDefault = Math.max(0, Number(payload.actionRetryDelayMs || 350));
  const autoScreenshotOnError = payload.autoScreenshotOnError !== false;
  const errorScreenshotDir = toStr(payload.errorScreenshotDir || "sessions/screens/errors");
  const viewport = payload.viewport || { width: 1280, height: 720 };
  const waitUntil = payload.waitUntil || "domcontentloaded";
  const userAgent = payload.userAgent ? String(payload.userAgent) : null;
  const headers = payload.headers && typeof payload.headers === "object" ? payload.headers : null;
  const returnHtml = Boolean(payload.returnHtml);
  const blockResourceTypes = Array.isArray(payload.blockResourceTypes)
    ? payload.blockResourceTypes.map((x) => String(x).toLowerCase())
    : [];
  const blockUrlRules = Array.isArray(payload.blockUrlRules) ? payload.blockUrlRules : [];
  const storageStatePath = payload.storageStatePath ? ensureAllowedPath(payload.storageStatePath) : null;
  const saveStorageStatePath = payload.saveStorageStatePath
    ? ensureAllowedPath(payload.saveStorageStatePath)
    : null;
  const traceId = toStr(payload.traceId || crypto.randomUUID().slice(0, 8));

  async function executeOnce(headless, runAttempt) {
    const browser = await chromium.launch({ headless });
    const result = {
      ok: true,
      traceId,
      mode: headless ? "headless" : "headful",
      runAttempt,
      steps: [],
      extractedText: null,
      extractedItems: null,
      screenshots: [],
      downloads: [],
      finalUrl: null,
      title: null,
      html: null
    };
    let page = null;
    try {
      const contextOptions = { viewport };
      if (userAgent) contextOptions.userAgent = userAgent;
      if (storageStatePath && fs.existsSync(storageStatePath)) {
        contextOptions.storageState = storageStatePath;
      }
      const context = await browser.newContext(contextOptions);
      if (headers) {
        await context.setExtraHTTPHeaders(
          Object.fromEntries(
            Object.entries(headers).map(([k, v]) => [String(k), toStr(v)])
          )
        );
      }
      if (blockResourceTypes.length || blockUrlRules.length) {
        await context.route("**/*", (route) => {
          const req = route.request();
          const type = String(req.resourceType() || "").toLowerCase();
          const reqUrl = req.url();
          const blockedByType = blockResourceTypes.includes(type);
          const blockedByRule = blockUrlRules.some((rule) => matchesUrlRule(reqUrl, rule));
          if (blockedByType || blockedByRule) return route.abort();
          return route.continue();
        });
      }

      page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      await page.goto(url, { waitUntil, timeout: timeoutMs });

      for (let idx = 0; idx < actions.length; idx += 1) {
        const action = actions[idx];
        const type = String(action?.type || "").toLowerCase();
        const startedAt = Date.now();
        const step = {
          traceId,
          index: idx,
          type,
          ok: true,
          meta: {
            selector: action?.selector ? String(action.selector) : undefined
          },
          attempts: 0,
          ms: 0
        };
        const retryTimes = Math.max(0, Number(action?.retryTimes ?? actionRetryTimesDefault));
        const retryDelayMs = Math.max(0, Number(action?.retryDelayMs ?? actionRetryDelayMsDefault));
        let nonRetriable = false;

        for (let attempt = 1; attempt <= retryTimes + 1; attempt += 1) {
          step.attempts = attempt;
          try {
            if (type === "wait") {
              await page.waitForTimeout(Number(action.ms || 0));
            } else if (type === "goto") {
              const targetUrl = String(action.url || "");
              if (!targetUrl) {
                step.ok = false;
                step.error = "missing_url";
                nonRetriable = true;
              } else {
                const wu = action.waitUntil || waitUntil;
                await page.goto(targetUrl, { waitUntil: wu, timeout: Number(action.timeoutMs || timeoutMs) });
              }
            } else if (type === "click") {
              await page.click(action.selector, { timeout: timeoutMs });
            } else if (type === "hover") {
              await page.hover(action.selector, { timeout: timeoutMs });
            } else if (type === "type") {
              if (action.clear) await page.fill(action.selector, "");
              await page.type(action.selector, String(action.text || ""), {
                delay: action.delay || 0,
                timeout: timeoutMs
              });
            } else if (type === "fill") {
              await page.fill(action.selector, toStr(action.text), { timeout: timeoutMs });
            } else if (type === "press") {
              await page.press(action.selector, String(action.key || "Enter"), { timeout: timeoutMs });
            } else if (type === "select") {
              const values = Array.isArray(action.values) ? action.values.map(toStr) : [];
              if (!values.length) {
                step.ok = false;
                step.error = "missing_values";
                nonRetriable = true;
              } else {
                await page.selectOption(action.selector, values, { timeout: timeoutMs });
              }
            } else if (type === "check") {
              await page.check(action.selector, { timeout: timeoutMs });
            } else if (type === "uncheck") {
              await page.uncheck(action.selector, { timeout: timeoutMs });
            } else if (type === "upload" || type === "set_input_files") {
              const files = Array.isArray(action.files) ? action.files : action.file ? [action.file] : [];
              if (!files.length) {
                step.ok = false;
                step.error = "missing_files";
                nonRetriable = true;
              } else {
                const resolved = files.map((p) => ensureAllowedPath(p));
                await page.setInputFiles(action.selector, resolved, { timeout: timeoutMs });
              }
            } else if (type === "scroll") {
              const x = Number(action.x || 0);
              const y = Number(action.y || 0);
              await page.evaluate(
                ({ x, y }) => window.scrollBy(x, y),
                { x, y }
              );
            } else if (type === "screenshot") {
              const shotPath = ensureAllowedPath(action.path || "");
              if (shotPath) {
                await page.screenshot({ path: shotPath, fullPage: Boolean(action.fullPage) });
                result.screenshots.push(shotPath);
              }
            } else if (type === "extract") {
              const selector = action.selector;
              const maxChars = Number(action.maxChars || 2000);
              const text = selector
                ? await page.$eval(selector, (el) => el.innerText || el.textContent || "")
                : await safeEval(page, () => document.body?.innerText || "");
              result.extractedText = clampText(text, maxChars);
            } else if (type === "extract_html") {
              const selector = action.selector;
              const maxChars = Number(action.maxChars || 20000);
              const html = selector
                ? await page.$eval(selector, (el) => el.outerHTML || "")
                : await page.content();
              result.extractedText = clampText(html, maxChars);
            } else if (type === "extract_all") {
              const selector = action.selector;
              const maxItems = Number(action.maxItems || 50);
              const maxChars = Number(action.maxChars || 200);
              if (!selector) {
                step.ok = false;
                step.error = "missing_selector";
                nonRetriable = true;
              } else {
                const items = await page.$$eval(selector, (els) =>
                  els.map((el) => (el.innerText || el.textContent || "").trim()).filter(Boolean)
                );
                result.extractedItems = items.slice(0, maxItems).map((t) => clampText(t, maxChars));
              }
            } else if (type === "extract_attr") {
              const selector = action.selector;
              const attr = String(action.attr || "");
              const maxItems = Number(action.maxItems || 50);
              const maxChars = Number(action.maxChars || 500);
              if (!selector) {
                step.ok = false;
                step.error = "missing_selector";
                nonRetriable = true;
              } else if (!attr) {
                step.ok = false;
                step.error = "missing_attr";
                nonRetriable = true;
              } else {
                const items = await page.$$eval(
                  selector,
                  (els, attrName) =>
                    els
                      .map((el) => el.getAttribute(String(attrName)) || "")
                      .map((s) => String(s).trim())
                      .filter(Boolean),
                  attr
                );
                result.extractedItems = items.slice(0, maxItems).map((t) => clampText(t, maxChars));
              }
            } else if (type === "extract_regex") {
              const source = action.source === "html" ? toStr(result.html || "") : pickSourceText(result);
              const patterns = action.patterns && typeof action.patterns === "object" ? action.patterns : {};
              const out = {};
              for (const [k, cfg] of Object.entries(patterns)) {
                const pattern = toStr(cfg?.pattern || "");
                if (!pattern) {
                  out[k] = null;
                  continue;
                }
                const flags = toStr(cfg?.flags || "");
                try {
                  const re = new RegExp(pattern, flags);
                  const m = source.match(re);
                  if (!m) {
                    out[k] = null;
                    continue;
                  }
                  if (cfg?.group !== undefined) {
                    out[k] = m[Number(cfg.group)] ?? null;
                  } else if (m.length > 1) {
                    out[k] = m[1] ?? null;
                  } else {
                    out[k] = m[0] ?? null;
                  }
                } catch {
                  out[k] = null;
                }
              }
              result.extractedItems = out;
            } else if (type === "transform_text") {
              const source = action.source === "html" ? toStr(result.html || "") : pickSourceText(result);
              const transformed = applyTextTransforms(source, action.transforms);
              result.extractedText = clampText(transformed, Number(action.maxChars || 20000));
            } else if (type === "wait_for") {
              await page.waitForSelector(action.selector, { timeout: timeoutMs });
            } else if (type === "wait_for_url") {
              const u = String(action.url || "");
              const waitMs = Number(action.timeoutMs || timeoutMs);
              if (!u) {
                step.ok = false;
                step.error = "missing_url";
                nonRetriable = true;
              } else {
                await page.waitForURL(u, { timeout: waitMs });
              }
            } else if (type === "wait_for_request") {
              const waitMs = Number(action.timeoutMs || timeoutMs);
              const contains = toStr(action.urlContains);
              const method = toStr(action.method || "").toUpperCase();
              await page.waitForRequest(
                (req) => {
                  const okUrl = contains ? req.url().includes(contains) : true;
                  const okMethod = method ? String(req.method()).toUpperCase() === method : true;
                  return okUrl && okMethod;
                },
                { timeout: waitMs }
              );
            } else if (type === "wait_for_response") {
              const waitMs = Number(action.timeoutMs || timeoutMs);
              const contains = toStr(action.urlContains);
              const status = action.status === undefined ? null : Number(action.status);
              await page.waitForResponse(
                (res) => {
                  const okUrl = contains ? res.url().includes(contains) : true;
                  const okStatus = status === null ? true : Number(res.status()) === status;
                  return okUrl && okStatus;
                },
                { timeout: waitMs }
              );
            } else if (type === "download_click") {
              const selector = toStr(action.selector);
              const filePath = ensureAllowedPath(toStr(action.path));
              if (!selector || !filePath) {
                step.ok = false;
                step.error = "missing_selector_or_path";
                nonRetriable = true;
              } else {
                const downloadPromise = page.waitForEvent("download", {
                  timeout: Number(action.timeoutMs || timeoutMs)
                });
                await page.click(selector, { timeout: timeoutMs });
                const download = await downloadPromise;
                await download.saveAs(filePath);
                result.downloads.push(filePath);
              }
            } else if (type === "wait_for_text") {
              const text = String(action.text || "");
              const waitMs = Number(action.timeoutMs || timeoutMs);
              if (text) {
                await page.waitForFunction(
                  (t) => document.body && document.body.innerText.includes(t),
                  text,
                  { timeout: waitMs }
                );
              } else {
                step.ok = false;
                step.error = "missing_text";
                nonRetriable = true;
              }
            } else if (type === "wait_for_any_text") {
              const texts = Array.isArray(action.texts) ? action.texts.map(String).filter(Boolean) : [];
              const waitMs = Number(action.timeoutMs || timeoutMs);
              if (texts.length) {
                await page.waitForFunction(
                  (arr) => {
                    const body = document.body?.innerText || "";
                    return Array.isArray(arr) && arr.some((t) => body.includes(String(t)));
                  },
                  texts,
                  { timeout: waitMs }
                );
              } else {
                step.ok = false;
                step.error = "missing_texts";
                nonRetriable = true;
              }
            } else {
              step.ok = false;
              step.error = "unknown_action";
              nonRetriable = true;
            }

            if (step.ok === false && nonRetriable) break;
            if (step.ok !== false) {
              step.ok = true;
              break;
            }
          } catch (error) {
            step.ok = false;
            step.error = String(error?.message || error);
            if (autoScreenshotOnError && page) {
              try {
                const shotRel = buildErrorScreenshotPath(errorScreenshotDir, traceId, runAttempt, idx, type, attempt);
                const shotAbs = ensureAllowedPath(shotRel);
                await page.screenshot({ path: shotAbs, fullPage: true });
                result.screenshots.push(shotAbs);
                step.errorScreenshot = shotAbs;
              } catch {
                // best effort
              }
            }
            if (attempt <= retryTimes) {
              if (retryDelayMs > 0) await sleep(retryDelayMs);
              continue;
            }
          }
          break;
        }
        step.ms = Date.now() - startedAt;
        result.steps.push(step);
      }

      try {
        result.finalUrl = page.url();
        result.title = await page.title();
      } catch {
        // best effort
      }
      if (returnHtml) {
        try {
          result.html = await page.content();
        } catch {
          // best effort
        }
      }

      if (saveStorageStatePath) {
        const state = await context.storageState();
        fs.writeFileSync(saveStorageStatePath, JSON.stringify(state, null, 2));
      }

      result.ok = result.steps.every((s) => s.ok);
      return result;
    } finally {
      await browser.close();
    }
  }

  const runAttempts = runRetryTimes + 1;
  let lastFatalError = null;
  let lastNonOkResult = null;
  for (let runAttempt = 1; runAttempt <= runAttempts; runAttempt += 1) {
    try {
      const out = await executeOnce(initialHeadless, runAttempt);
      if (out.ok) {
        return JSON.stringify(out, null, 2);
      }
      lastNonOkResult = out;
    } catch (error) {
      lastFatalError = String(error?.message || error);
    }
    if (runAttempt < runAttempts) await sleep(actionRetryDelayMsDefault);
  }

  if (initialHeadless && autoFallbackHeadful) {
    try {
      const fallbackOut = await executeOnce(false, 1);
      fallbackOut.fallbackUsed = true;
      fallbackOut.fallbackReason = "headless_failed_or_unstable";
      return JSON.stringify(fallbackOut, null, 2);
    } catch (error) {
      lastFatalError = String(error?.message || error);
    }
  }

  return JSON.stringify(
    {
      ok: false,
      traceId,
      error: "run_failed",
      details: lastFatalError || "non_ok_steps",
      lastResult: lastNonOkResult
    },
    null,
    2
  );
}
