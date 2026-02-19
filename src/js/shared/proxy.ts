import { bootstrap } from "global-agent";

let bootstrapped = false;

function mergeNoProxyList(...values: Array<string | undefined>): string {
  const parts: string[] = [];
  for (const value of values) {
    if (!value) continue;
    for (const item of value.split(",")) {
      const trimmed = item.trim();
      if (trimmed) parts.push(trimmed);
    }
  }
  return Array.from(new Set(parts)).join(",");
}

export function enableGlobalProxy(proxyUrl?: string): void {
  if (!proxyUrl) return;

  process.env.GLOBAL_AGENT_HTTP_PROXY = proxyUrl;
  process.env.GLOBAL_AGENT_HTTPS_PROXY = proxyUrl;
  // Allow bypassing proxy for specific hosts (e.g. WeCom requires stable/whitelisted egress IP).
  const defaults = "127.0.0.1,localhost,*.local";
  process.env.GLOBAL_AGENT_NO_PROXY = mergeNoProxyList(
    process.env.GLOBAL_AGENT_NO_PROXY,
    process.env.JPCLAW_NO_PROXY,
    process.env.NO_PROXY,
    process.env.no_proxy,
    defaults
  );

  if (bootstrapped) return;
  bootstrap();
  bootstrapped = true;
}
