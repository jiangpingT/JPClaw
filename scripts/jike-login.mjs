import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const profileUrl =
  process.argv[2] || "https://web.okjike.com/u/311E40FB-E5EA-4AF0-A795-44CC5D6B380C";
const outDir = path.resolve(process.cwd(), "sessions", "jike");
const outPath = path.join(outDir, "storage.json");

fs.mkdirSync(outDir, { recursive: true });

console.log("Launching browser for Jike login...");
console.log("1) Login in the opened browser.");
console.log("2) Navigate to the profile page.");
console.log("3) Return here and press Enter to save session.");

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

process.stdin.setEncoding("utf-8");
process.stdin.once("data", async () => {
  const state = await context.storageState();
  fs.writeFileSync(outPath, JSON.stringify(state, null, 2));
  console.log(`Saved storage state to ${outPath}`);
  await browser.close();
  process.exit(0);
});
