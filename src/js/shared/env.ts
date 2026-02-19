import dotenv from "dotenv";
import { enableGlobalProxy } from "./proxy.js";

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  if (process.env.JPCLAW_SKIP_DOTENV === "true") {
    loaded = true;
    return;
  }
  dotenv.config();
  applyProxyEnvDefaults();
  loaded = true;
}

function applyProxyEnvDefaults(): void {
  // 使用 global-agent 提供全局代理（正统方案）
  // 代理 URL 通常是本地地址（如 127.0.0.1），不适用通用的 SSRF 防护校验
  const proxyUrl = process.env.DISCORD_PROXY_URL;
  if (proxyUrl && /^https?:\/\//.test(proxyUrl)) {
    enableGlobalProxy(proxyUrl);
  }
}
