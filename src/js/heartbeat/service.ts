import fs from "node:fs";
import path from "node:path";
import type { DiscordRuntime, DiscordStatus } from "../channels/discord-legacy.js";
import { log } from "../shared/logger.js";
import { snapshotMetrics, type MetricsSnapshot } from "../shared/metrics.js";

export type HeartbeatOptions = {
  enabled: boolean;
  intervalMinutes: number;
  inboxDir: string;
  ownerUserId: string;
  ownerDmEnabled: boolean;
  // "important" avoids spamming; "always" sends every tick.
  ownerDmMode: "important" | "always";
  startupGraceSeconds?: number;
  disconnectDmThreshold?: number;
  onDailyFirstTick?: () => Promise<{ title: string; body: string; important?: boolean } | null>;
};

type HeartbeatResult = {
  important: boolean;
  title: string;
  body: string;
};

function nowStamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function dailyFile(inboxDir: string, date: Date): string {
  const stamp = date.toISOString().slice(0, 10);
  return path.join(inboxDir, `heartbeat-${stamp}.md`);
}

function ensureInboxDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function formatDiscordStatus(status: DiscordStatus): string {
  const parts: string[] = [];
  parts.push(`enabled=${status.enabled}`);
  parts.push(`connected=${status.connected}`);
  if (status.user) parts.push(`user=${status.user}`);
  if (status.lastError) parts.push(`lastError=${status.lastError}`);
  if (status.retryInMs != null) parts.push(`retryInMs=${status.retryInMs}`);
  return parts.join(" ");
}

function diskSnapshot(): { ok: boolean; freeBytes: number; totalBytes: number; freePct: number } {
  try {
    // Node >= 18 has statfsSync.
    const anyFs = fs as any;
    if (typeof anyFs.statfsSync !== "function") {
      return { ok: false, freeBytes: 0, totalBytes: 0, freePct: 0 };
    }
    const st = anyFs.statfsSync(process.cwd());
    const freeBytes = Number(st?.bavail || 0) * Number(st?.bsize || 0);
    const totalBytes = Number(st?.blocks || 0) * Number(st?.bsize || 0);
    const freePct = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;
    return { ok: true, freeBytes, totalBytes, freePct };
  } catch {
    return { ok: false, freeBytes: 0, totalBytes: 0, freePct: 0 };
  }
}

function formatBytes(bytes: number): string {
  const b = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

function summarizeMetrics(snapshot: MetricsSnapshot): Array<{ key: string; text: string; important: boolean }> {
  const lines: Array<{ key: string; text: string; important: boolean }> = [];
  const windowMinutes = Number(process.env.JPCLAW_HEARTBEAT_METRICS_WINDOW_MINUTES || "30");
  const w = Number.isFinite(windowMinutes) ? Math.max(5, windowMinutes) : 30;

  const web = snapshot["web.search"];
  if (web) {
    const failRateThreshold = Number(process.env.JPCLAW_HEARTBEAT_WEB_FAIL_RATE_THRESHOLD || "0.7");
    const minTotal = Number(process.env.JPCLAW_HEARTBEAT_WEB_MIN_TOTAL || "3");
    const important =
      web.total >= (Number.isFinite(minTotal) ? minTotal : 3) &&
      web.failRate >= (Number.isFinite(failRateThreshold) ? failRateThreshold : 0.7);
    lines.push({
      key: "web.search",
      important,
      text: `- web.search(${w}m): total=${web.total} fail=${web.fail} failRate=${Math.round(web.failRate * 100)}% p95=${Math.round(
        web.p95DurationMs || 0
      )}ms`
    });
  }

  const anth = snapshot["provider.anthropic"];
  if (anth) {
    const threshold = Number(process.env.JPCLAW_HEARTBEAT_LLM_FAIL_THRESHOLD || "2");
    const important = anth.fail >= (Number.isFinite(threshold) ? threshold : 2);
    lines.push({
      key: "provider.anthropic",
      important,
      text: `- provider.anthropic(${w}m): total=${anth.total} fail=${anth.fail} p95=${Math.round(anth.p95DurationMs || 0)}ms`
    });
  }

  const oa = snapshot["provider.openai"];
  if (oa) {
    const threshold = Number(process.env.JPCLAW_HEARTBEAT_LLM_FAIL_THRESHOLD || "2");
    const important = oa.fail >= (Number.isFinite(threshold) ? threshold : 2);
    lines.push({
      key: "provider.openai",
      important,
      text: `- provider.openai(${w}m): total=${oa.total} fail=${oa.fail} p95=${Math.round(oa.p95DurationMs || 0)}ms`
    });
  }

  const bm25q = snapshot["bm25.query"];
  if (bm25q) {
    const threshold = Number(process.env.JPCLAW_HEARTBEAT_BM25_FAIL_THRESHOLD || "5");
    const important = bm25q.fail >= (Number.isFinite(threshold) ? threshold : 5);
    lines.push({
      key: "bm25.query",
      important,
      text: `- bm25.query(${w}m): total=${bm25q.total} fail=${bm25q.fail} p95=${Math.round(bm25q.p95DurationMs || 0)}ms`
    });
  }

  const bm25i = snapshot["bm25.index"];
  if (bm25i) {
    const threshold = Number(process.env.JPCLAW_HEARTBEAT_BM25_INDEX_FAIL_THRESHOLD || "3");
    const important = bm25i.fail >= (Number.isFinite(threshold) ? threshold : 3);
    lines.push({
      key: "bm25.index",
      important,
      text: `- bm25.index(${w}m): total=${bm25i.total} fail=${bm25i.fail} p95=${Math.round(bm25i.p95DurationMs || 0)}ms`
    });
  }

  return lines;
}

function buildHeartbeat(discord: DiscordRuntime | null): HeartbeatResult {
  const title = `Heartbeat ${nowStamp()}`;
  const lines: string[] = [];
  let important = false;

  const metricsWindowMinutes = Number(process.env.JPCLAW_HEARTBEAT_METRICS_WINDOW_MINUTES || "30");
  const windowMs = (Number.isFinite(metricsWindowMinutes) ? Math.max(5, metricsWindowMinutes) : 30) * 60 * 1000;
  const metrics = snapshotMetrics(windowMs);
  const metricsLines = summarizeMetrics(metrics);
  if (metricsLines.length > 0) {
    lines.push("- metrics:");
    for (const m of metricsLines) {
      if (m.important) important = true;
      lines.push(m.text);
    }
  }

  const disk = diskSnapshot();
  if (disk.ok) {
    const thresholdPct = Number(process.env.JPCLAW_HEARTBEAT_DISK_FREE_PCT_THRESHOLD || "10");
    const minPct = Number.isFinite(thresholdPct) ? thresholdPct : 10;
    if (disk.freePct > 0 && disk.freePct < minPct) important = true;
    lines.push(
      `- disk: free=${formatBytes(disk.freeBytes)}/${formatBytes(disk.totalBytes)} (${disk.freePct.toFixed(1)}%)`
    );
  }

  if (process.env.JPCLAW_BM25_ENABLED === "false") {
    // Self-check can flip this at runtime; we surface it so the owner understands retrieval behavior.
    important = true;
    lines.push("- bm25: disabled");
  }

  if (!discord) {
    important = true;
    lines.push("- discord: not_configured");
  } else {
    const st = discord.getStatus();
    if (!st.connected) important = true;
    if (st.lastError) important = true;
    lines.push(`- discord: ${formatDiscordStatus(st)}`);
  }

  return {
    important,
    title,
    body: lines.join("\n")
  };
}

function appendToInbox(file: string, entry: HeartbeatResult): void {
  ensureInboxDir(path.dirname(file));
  const header = fs.existsSync(file) ? "" : "# JPClaw Heartbeat Inbox\n\n";
  const content = [
    header,
    `## ${entry.title}\n`,
    entry.body ? `${entry.body}\n` : "",
    "\n"
  ].join("");
  fs.appendFileSync(file, content, "utf-8");
}

export class HeartbeatService {
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  private consecutiveDiscordDisconnected = 0;
  private lastDailyStamp = "";

  constructor(private readonly options: HeartbeatOptions) {}

  start(discord: DiscordRuntime | null): void {
    if (!this.options.enabled) {
      log("info", "heartbeat.disabled");
      return;
    }

    const intervalMs = Math.max(1, this.options.intervalMinutes) * 60 * 1000;
    const tick = async (): Promise<void> => {
      try {
        const dayStamp = new Date().toISOString().slice(0, 10);
        const dailyHook = this.options.onDailyFirstTick;
        if (dailyHook && this.lastDailyStamp !== dayStamp) {
          this.lastDailyStamp = dayStamp;
          try {
            const extra = await dailyHook();
            if (extra) {
              const file = dailyFile(this.options.inboxDir, new Date());
              appendToInbox(file, { important: Boolean(extra.important), title: extra.title, body: extra.body });
            }
          } catch (error) {
            log("warn", "heartbeat.daily_hook.failed", { error: String(error) });
          }
        }

        const entry = buildHeartbeat(discord);
        const file = dailyFile(this.options.inboxDir, new Date());
        appendToInbox(file, entry);
        log("info", "heartbeat.tick", { important: entry.important, file });

        if (!discord) return;
        if (!this.options.ownerDmEnabled) return;

        const graceSeconds = Math.max(0, Number(this.options.startupGraceSeconds || 0));
        const inGrace = Date.now() - this.startedAt < graceSeconds * 1000;
        if (inGrace) return;

        const st = discord.getStatus();
        if (!st.connected) this.consecutiveDiscordDisconnected += 1;
        else this.consecutiveDiscordDisconnected = 0;

        const shouldDm =
          this.options.ownerDmMode === "always" ? true : Boolean(entry.important);
        if (!shouldDm) return;

        const threshold = Math.max(1, Number(this.options.disconnectDmThreshold || 1));
        if (!st.connected && this.consecutiveDiscordDisconnected < threshold) return;

        if (typeof discord.sendDm !== "function") return;
        const text = entry.important
          ? `JPClaw Heartbeat: detected issues. Inbox: ${path.basename(file)}`
          : `JPClaw Heartbeat ok. Inbox: ${path.basename(file)}`;
        const res = await discord.sendDm(this.options.ownerUserId, text);
        if (!res.ok) {
          log("warn", "heartbeat.dm_failed", { error: res.error || "unknown" });
        }
      } catch (error) {
        log("error", "heartbeat.tick_failed", { error: String(error) });
      }
    };

    // Run once quickly after start, then on interval.
    void tick();
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref?.();
    log("info", "heartbeat.started", { intervalMinutes: this.options.intervalMinutes });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    log("info", "heartbeat.stopped");
  }
}
