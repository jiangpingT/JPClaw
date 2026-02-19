import fs from "node:fs";
import path from "node:path";

export type CleanupReport = {
  removedTranscriptFiles: number;
  rotatedLogs: number;
};

function isOlderThan(filePath: string, days: number): boolean {
  try {
    const stat = fs.statSync(filePath);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return stat.mtimeMs < cutoff;
  } catch {
    return false;
  }
}

function listFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function rotateIfTooLarge(filePath: string, maxBytes: number): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (stat.size <= maxBytes) return false;
    const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    const backup = `${filePath}.${stamp}.bak`;
    fs.renameSync(filePath, backup);
    fs.writeFileSync(filePath, "", "utf-8");
    return true;
  } catch {
    return false;
  }
}

export async function runDailyCleanup(options?: {
  transcriptsDir?: string;
  transcriptRetentionDays?: number;
  logDir?: string;
  logMaxBytes?: number;
}): Promise<{ title: string; body: string; important: boolean } | null> {
  const transcriptsDir =
    options?.transcriptsDir || path.resolve(process.cwd(), "sessions", "pi", "transcripts");
  const retentionDays = Math.max(1, Number(options?.transcriptRetentionDays || "7"));
  const logDir = options?.logDir || path.resolve(process.cwd(), "log");
  const logMaxBytes = Math.max(1024 * 128, Number(options?.logMaxBytes || String(5 * 1024 * 1024)));

  const report: CleanupReport = { removedTranscriptFiles: 0, rotatedLogs: 0 };

  for (const file of listFiles(transcriptsDir)) {
    if (!isOlderThan(file, retentionDays)) continue;
    try {
      fs.rmSync(file, { force: true });
      report.removedTranscriptFiles += 1;
    } catch {
      // ignore
    }
  }

  for (const file of listFiles(logDir)) {
    if (rotateIfTooLarge(file, logMaxBytes)) report.rotatedLogs += 1;
  }

  if (report.removedTranscriptFiles === 0 && report.rotatedLogs === 0) return null;
  return {
    important: false,
    title: `Daily cleanup ${new Date().toISOString().slice(0, 10)}`,
    body: [`- removed_transcripts: ${report.removedTranscriptFiles}`, `- rotated_logs: ${report.rotatedLogs}`].join(
      "\n"
    )
  };
}

