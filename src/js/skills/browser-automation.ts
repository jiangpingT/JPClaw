import path from "node:path";
import fs from "node:fs";
import { chromium } from "playwright";

type Action =
  | { type: "wait"; ms: number }
  | { type: "click"; selector: string }
  | { type: "type"; selector: string; text: string; clear?: boolean }
  | { type: "press"; selector: string; key: string }
  | { type: "scroll"; x?: number; y?: number }
  | { type: "screenshot"; path: string; fullPage?: boolean }
  | { type: "extract"; selector: string; maxChars?: number }
  | { type: "goto"; url: string };

type BrowserAutomationInput = {
  url?: string;
  actions?: Action[];
  headless?: boolean;
  timeoutMs?: number;
  viewport?: { width: number; height: number };
};

export async function runBrowserAutomation(rawInput: string): Promise<string> {
  const payload = parseInput(rawInput);
  const timeoutMs = Number(payload.timeoutMs || 15000);
  const headless = payload.headless !== false;
  const actions: Action[] = Array.isArray(payload.actions) ? payload.actions : [];
  const url = payload.url || (actions.find((a) => a.type === "goto") as any)?.url;
  if (!url) {
    return JSON.stringify({ ok: false, error: "missing_url" }, null, 2);
  }

  const browser = await chromium.launch({ headless });
  const page = await browser.newPage({
    viewport: payload.viewport || { width: 1280, height: 720 }
  });
  page.setDefaultTimeout(timeoutMs);

  const results: Array<{ action: string; ok: boolean; error?: string }> = [];
  const screenshots: string[] = [];
  let extractedText = "";

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    results.push({ action: "goto", ok: true });

    for (const action of actions) {
      if (action.type === "goto") {
        await page.goto(action.url, { waitUntil: "domcontentloaded" });
        results.push({ action: "goto", ok: true });
        continue;
      }
      if (action.type === "wait") {
        await page.waitForTimeout(action.ms);
        results.push({ action: "wait", ok: true });
        continue;
      }
      if (action.type === "click") {
        try {
          await page.locator(action.selector).first().click();
          results.push({ action: "click", ok: true });
        } catch (error) {
          results.push({ action: "click", ok: false, error: String(error) });
        }
        continue;
      }
      if (action.type === "type") {
        try {
          const loc = page.locator(action.selector).first();
          if (action.clear) {
            await loc.fill("");
          }
          await loc.type(action.text);
          results.push({ action: "type", ok: true });
        } catch (error) {
          results.push({ action: "type", ok: false, error: String(error) });
        }
        continue;
      }
      if (action.type === "press") {
        try {
          await page.locator(action.selector).first().press(action.key);
          results.push({ action: "press", ok: true });
        } catch (error) {
          results.push({ action: "press", ok: false, error: String(error) });
        }
        continue;
      }
      if (action.type === "scroll") {
        const x = Number(action.x || 0);
        const y = Number(action.y || 0);
        await page.mouse.wheel(x, y);
        results.push({ action: "scroll", ok: true });
        continue;
      }
      if (action.type === "screenshot") {
        try {
          const targetPath = ensureSafePath(action.path);
          await page.screenshot({ path: targetPath, fullPage: Boolean(action.fullPage) });
          screenshots.push(action.path);
          results.push({ action: "screenshot", ok: true });
        } catch (error) {
          results.push({ action: "screenshot", ok: false, error: String(error) });
        }
        continue;
      }
      if (action.type === "extract") {
        try {
          const text = await page.locator(action.selector).first().innerText();
          const maxChars = Number(action.maxChars || 1200);
          extractedText = text.slice(0, maxChars);
          results.push({ action: "extract", ok: true });
        } catch (error) {
          results.push({ action: "extract", ok: false, error: String(error) });
        }
        continue;
      }
    }
  } finally {
    await browser.close();
  }

  return JSON.stringify(
    {
      ok: results.every((r) => r.ok),
      steps: results,
      extractedText,
      screenshots
    },
    null,
    2
  );
}

function parseInput(raw: string): BrowserAutomationInput {
  const text = String(raw || "").trim();
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

function ensureSafePath(relativePath: string): string {
  const safeRoot = process.cwd();
  const resolved = path.resolve(safeRoot, relativePath);
  if (!resolved.startsWith(`${safeRoot}${path.sep}`)) {
    throw new Error("screenshot path must be inside workspace");
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}
