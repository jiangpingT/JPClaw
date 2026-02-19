type MetricEvent = {
  t: number;
  ok: boolean;
  durationMs?: number;
  meta?: Record<string, string | number | boolean | null | undefined>;
};

type MetricSummary = {
  total: number;
  ok: number;
  fail: number;
  failRate: number;
  avgDurationMs?: number;
  p95DurationMs?: number;
  lastAt?: number;
};

export type MetricsSnapshot = Record<string, MetricSummary>;

const eventsByKind = new Map<string, MetricEvent[]>();

function maxEventsPerKind(): number {
  const raw = process.env.JPCLAW_METRICS_MAX_EVENTS_PER_KIND;
  const n = Number(raw || "2000");
  return Number.isFinite(n) ? Math.max(200, Math.min(20000, n)) : 2000;
}

export function recordMetric(
  kind: string,
  event: Omit<MetricEvent, "t"> & { t?: number }
): void {
  const k = String(kind || "").trim();
  if (!k) return;
  const e: MetricEvent = {
    t: typeof event.t === "number" ? event.t : Date.now(),
    ok: Boolean(event.ok),
    durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
    meta: event.meta
  };
  const list = eventsByKind.get(k) || [];
  list.push(e);
  const cap = maxEventsPerKind();
  if (list.length > cap) list.splice(0, list.length - cap);
  eventsByKind.set(k, list);
}

export function snapshotMetrics(windowMs: number): MetricsSnapshot {
  const w = Number.isFinite(windowMs) ? Math.max(10_000, windowMs) : 30 * 60 * 1000;
  const since = Date.now() - w;
  const out: MetricsSnapshot = {};

  for (const [kind, events] of eventsByKind.entries()) {
    const recent = events.filter((e) => e.t >= since);
    if (recent.length === 0) continue;
    let ok = 0;
    let fail = 0;
    const durs: number[] = [];
    let lastAt = 0;
    for (const e of recent) {
      if (e.ok) ok += 1;
      else fail += 1;
      if (typeof e.durationMs === "number" && Number.isFinite(e.durationMs)) durs.push(e.durationMs);
      lastAt = Math.max(lastAt, e.t);
    }
    let avgDurationMs: number | undefined;
    let p95DurationMs: number | undefined;
    if (durs.length > 0) {
      const sum = durs.reduce((a, b) => a + b, 0);
      avgDurationMs = sum / durs.length;
      durs.sort((a, b) => a - b);
      const idx = Math.min(durs.length - 1, Math.floor(durs.length * 0.95));
      p95DurationMs = durs[idx];
    }
    const total = ok + fail;
    out[kind] = {
      total,
      ok,
      fail,
      failRate: total > 0 ? fail / total : 0,
      avgDurationMs,
      p95DurationMs,
      lastAt
    };
  }

  return out;
}

