import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { runSkill } from "../skills/registry.js";
import { log } from "../shared/logger.js";

type TaskEntry = {
  id: string;
  name: string;
  schedule: string;
  action: string;
  payload?: any;
  createdAt: string;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  status: "active" | "paused" | "done";
};

const DEFAULT_FILE = path.resolve(process.cwd(), "sessions", "schedules", "tasks.json");

function loadTasks(filePath: string): TaskEntry[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveTasks(filePath: string, tasks: TaskEntry[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(tasks, null, 2));
}

function parseRrule(rule: string): Record<string, string> {
  const out: Record<string, string> = {};
  rule
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean)
    .forEach((part) => {
      const [k, v] = part.split("=");
      if (k && v) out[k.toUpperCase()] = v;
    });
  return out;
}

function parseWeekdays(value: string): number[] {
  const map: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };
  return value
    .split(",")
    .map((v) => v.trim().toUpperCase())
    .map((v) => map[v])
    .filter((v) => v !== undefined) as number[];
}

function computeNextRunAt(task: TaskEntry, now: Date): Date | null {
  if (task.nextRunAt) {
    const d = new Date(task.nextRunAt);
    if (!Number.isNaN(d.valueOf()) && d > now) return d;
  }

  const schedule = String(task.schedule || "").trim();
  if (!schedule) return null;

  if (/^\d{4}-\d{2}-\d{2}T/.test(schedule)) {
    const at = new Date(schedule);
    if (Number.isNaN(at.valueOf())) return null;
    return at;
  }

  if (/^every\s+\d+\s*(m|min|minute|minutes|h|hour|hours)$/i.test(schedule)) {
    const match = schedule.match(/every\s+(\d+)\s*(m|min|minute|minutes|h|hour|hours)/i);
    if (!match) return null;
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const ms = unit.startsWith("h") ? value * 60 * 60 * 1000 : value * 60 * 1000;
    const base = task.lastRunAt ? new Date(task.lastRunAt) : now;
    return new Date(base.getTime() + ms);
  }

  if (schedule.includes("FREQ=")) {
    const rule = parseRrule(schedule.replace(/^RRULE:/i, ""));
    const freq = rule.FREQ || "";
    const interval = Number(rule.INTERVAL || "1");
    const byHour = rule.BYHOUR ? Number(rule.BYHOUR) : 0;
    const byMinute = rule.BYMINUTE ? Number(rule.BYMINUTE) : 0;
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);

    if (freq === "HOURLY") {
      candidate.setMinutes(byMinute, 0, 0);
      if (candidate <= now) candidate.setHours(candidate.getHours() + interval);
      return candidate;
    }
    if (freq === "DAILY") {
      candidate.setHours(byHour, byMinute, 0, 0);
      if (candidate <= now) candidate.setDate(candidate.getDate() + interval);
      return candidate;
    }
    if (freq === "WEEKLY") {
      const days = rule.BYDAY ? parseWeekdays(rule.BYDAY) : [candidate.getDay()];
      for (let i = 0; i < 14; i += 1) {
        const d = new Date(candidate);
        d.setDate(candidate.getDate() + i);
        d.setHours(byHour, byMinute, 0, 0);
        if (days.includes(d.getDay()) && d > now) return d;
      }
    }
  }

  return null;
}

function runShell(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: timeoutMs, cwd: process.cwd() }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve([stdout, stderr].filter(Boolean).join("\n").trim());
    });
  });
}

async function executeTask(task: TaskEntry): Promise<void> {
  const action = String(task.action || "").trim();
  if (!action) return;
  if (action.startsWith("skill:")) {
    const name = action.replace(/^skill:/, "").trim();
    const output = await runSkill(name, JSON.stringify(task.payload ?? {}));
    assertSkillExecutionSucceeded(name, output);
    return;
  }
  if (action.startsWith("run:skills/")) {
    const name = action.replace(/^run:skills\//, "").trim();
    const output = await runSkill(name, JSON.stringify(task.payload ?? {}));
    assertSkillExecutionSucceeded(name, output);
    return;
  }
  if (action.startsWith("shell:")) {
    const command = action.replace(/^shell:/, "").trim();
    await runShell(command, 15000);
  }
}

function assertSkillExecutionSucceeded(skillName: string, output: string): void {
  const text = String(output ?? "").trim();
  if (!text) return;
  try {
    const parsed = JSON.parse(text) as { ok?: unknown; status?: unknown; error?: unknown };
    if (typeof parsed?.ok === "boolean" && parsed.ok === false) {
      const statusText = parsed.status !== undefined ? ` status=${String(parsed.status)}` : "";
      const errorText = parsed.error ? ` error=${String(parsed.error)}` : "";
      throw new Error(`skill ${skillName} reported failure.${statusText}${errorText}`);
    }
  } catch (error) {
    // Ignore non-JSON outputs; those are treated as successful tool completion.
    if (error instanceof SyntaxError) return;
    throw error;
  }
}

export async function runSchedulerOnce(filePath = DEFAULT_FILE): Promise<void> {
  const tasks = loadTasks(filePath);
  if (!tasks.length) {
    log("debug", "scheduler.tick.no_tasks");
    return;
  }
  const now = new Date();
  log("debug", "scheduler.tick.start", { taskCount: tasks.length, now: now.toISOString() });
  let changed = false;
  for (const task of tasks) {
    if (task.status !== "active") {
      log("debug", "scheduler.task.skipped.inactive", { taskId: task.id, status: task.status });
      continue;
    }
    let dueNow = false;
    if (task.nextRunAt) {
      const persistedNext = new Date(task.nextRunAt);
      if (!Number.isNaN(persistedNext.valueOf()) && persistedNext <= now) {
        dueNow = true;
        log("debug", "scheduler.task.due", { taskId: task.id, nextRunAt: task.nextRunAt });
      }
    }

    const next = computeNextRunAt(task, now);
    log("debug", "scheduler.task.compute_next", { taskId: task.id, next: next?.toISOString(), dueNow });
    if (!next && !dueNow) {
      log("debug", "scheduler.task.skipped.not_ready", { taskId: task.id });
      continue;
    }

    if (dueNow || (next && next <= now)) {
      // 执行前先推进 nextRunAt 并存盘：防止服务在执行中途崩溃后重启时重复触发
      task.lastRunAt = now.toISOString();
      task.nextRunAt = computeNextRunAt(task, now)?.toISOString() || null;
      if (/^\d{4}-\d{2}-\d{2}T/.test(task.schedule || "")) {
        task.status = "done";
      }
      saveTasks(filePath, tasks);
      log("info", "scheduler.task.executing", { taskId: task.id, action: task.action, newNextRunAt: task.nextRunAt });

      try {
        await executeTask(task);
        log("info", "scheduler.task.executed", { taskId: task.id });
      } catch (error) {
        log("warn", "scheduler.task.failed", { taskId: task.id, error: String(error) });
      }
      // nextRunAt 已在执行前存盘，无需再 changed = true
    } else if (next && task.nextRunAt !== next.toISOString()) {
      log("debug", "scheduler.task.update_next", { taskId: task.id, oldNext: task.nextRunAt, newNext: next.toISOString() });
      task.nextRunAt = next.toISOString();
      changed = true;
    }
  }
  if (changed) saveTasks(filePath, tasks);
  log("debug", "scheduler.tick.complete", { changed });
}

export function startScheduler(options?: { filePath?: string; intervalMs?: number }): NodeJS.Timer {
  const intervalMs = options?.intervalMs ?? Number(process.env.JPCLAW_SCHEDULER_INTERVAL_MS || "60000");
  const filePath = options?.filePath ?? DEFAULT_FILE;
  runSchedulerOnce(filePath).catch((error) => {
    log("warn", "scheduler.bootstrap.failed", { error: String(error) });
  });
  const timer = setInterval(() => {
    runSchedulerOnce(filePath).catch((error) => {
      log("warn", "scheduler.tick.failed", { error: String(error) });
    });
  }, intervalMs);
  return timer;
}
