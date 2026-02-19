import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const REPO = "openclaw/openclaw";
const REF = "main";
const API_BASE = `https://api.github.com/repos/${REPO}`;
const WORKSPACE_ROOT = process.cwd();

const TARGET_DIRS = ["skills/", ".agents/skills/"];

function fetchJson(url) {
  const output = execSync(`curl -s "${url}"`, { stdio: ["ignore", "pipe", "pipe"] }).toString("utf-8");
  return JSON.parse(output);
}

function main() {
  const tree = fetchJson(`${API_BASE}/git/trees/${REF}?recursive=1`);
  const items = Array.isArray(tree?.tree) ? tree.tree : [];
  for (const item of items) {
    if (item.type !== "blob") continue;
    if (!TARGET_DIRS.some((prefix) => item.path.startsWith(prefix))) continue;
    const destPath = path.join(WORKSPACE_ROOT, item.path);
    if (fs.existsSync(destPath)) continue;
    const blob = fetchJson(`${API_BASE}/git/blobs/${item.sha}`);
    const content = Buffer.from(blob.content || "", "base64");
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, content);
  }
  console.log("OpenClaw skills import complete.");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
