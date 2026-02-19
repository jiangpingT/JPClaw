import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { log } from "../shared/logger.js";

export type PiSessionMeta = {
  sessionKey: string;
  userId: string;
  channelId?: string;
  headId?: string;
  activeBranch?: string;
  createdAt: string;
  updatedAt: string;
};

export type PiTranscriptEntry = {
  id: string;
  parentId?: string;
  sessionKey: string;
  role: string;
  timestamp: number;
  text?: string;
  message: AgentMessage;
};

export type PiSessionFile = {
  sessionKey: string;
  userId: string;
  channelId?: string;
  messages: AgentMessage[];
  summary?: string;
  updatedAt: string;
  schemaVersion: number;
};

export class PiSessionStore {
  private readonly sessionsDir: string;
  private readonly transcriptsDir: string;
  private readonly sessionsIndexFile: string;

  constructor(private readonly baseDir: string) {
    this.sessionsDir = path.join(baseDir, "users");
    this.transcriptsDir = path.join(baseDir, "transcripts");
    this.sessionsIndexFile = path.join(baseDir, "sessions.json");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    fs.mkdirSync(this.transcriptsDir, { recursive: true });
  }

  loadSession(sessionKey: string): PiSessionFile | null {
    const file = this.sessionFile(sessionKey);
    if (!fs.existsSync(file)) return null;
    try {
      const raw = fs.readFileSync(file, "utf-8");
      return JSON.parse(raw) as PiSessionFile;
    } catch (error) {
      log("warn", "pi.session.load_failed", { error: String(error) });
      return null;
    }
  }

  saveSession(payload: PiSessionFile): void {
    const file = this.sessionFile(payload.sessionKey);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  }

  loadSessionsIndex(): Record<string, PiSessionMeta> {
    if (!fs.existsSync(this.sessionsIndexFile)) return {};
    try {
      const raw = fs.readFileSync(this.sessionsIndexFile, "utf-8");
      return JSON.parse(raw) as Record<string, PiSessionMeta>;
    } catch (error) {
      log("warn", "pi.sessions.index_load_failed", { error: String(error) });
      return {};
    }
  }

  updateSessionsIndex(meta: PiSessionMeta): void {
    const index = this.loadSessionsIndex();
    index[meta.sessionKey] = meta;
    fs.writeFileSync(this.sessionsIndexFile, JSON.stringify(index, null, 2));
  }

  appendTranscript(entries: PiTranscriptEntry[]): void {
    if (!entries.length) return;
    const file = this.transcriptFile(entries[0].sessionKey);
    const lines = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    fs.appendFileSync(file, lines);
  }

  /**
   * 构建session key，使用明确的分隔符避免歧义
   *
   * 格式：
   * - 无channelId: "user:<userId>"
   * - 有channelId: "user:<userId>|channel:<channelId>"
   *
   * 这样可以避免以下歧义：
   * - userId="user1::channel2", channelId=undefined
   * - userId="user1", channelId="channel2"
   * 以上两种情况现在会产生不同的key
   */
  buildSessionKey(userId: string, channelId?: string): string {
    if (channelId) {
      return `user:${userId}|channel:${channelId}`;
    }
    return `user:${userId}`;
  }

  /**
   * 解析session key，提取userId和channelId
   */
  parseSessionKey(sessionKey: string): { userId: string; channelId?: string } {
    // 移除分支后缀（如果有）
    const baseKey = sessionKey.split('#')[0];

    if (baseKey.includes('|channel:')) {
      const [userPart, channelPart] = baseKey.split('|channel:');
      const userId = userPart.replace('user:', '');
      return { userId, channelId: channelPart };
    }

    return { userId: baseKey.replace('user:', '') };
  }

  listBranchKeys(baseKey: string): string[] {
    const index = this.loadSessionsIndex();
    const prefix = `${baseKey}#`;
    return Object.keys(index).filter((key) => key.startsWith(prefix));
  }

  createEntryId(): string {
    return randomBytes(8).toString("hex");
  }

  hashSessionKey(sessionKey: string): string {
    return createHash("sha256").update(sessionKey).digest("hex").slice(0, 24);
  }

  private sessionFile(sessionKey: string): string {
    const hash = this.hashSessionKey(sessionKey);
    return path.join(this.sessionsDir, `s_${hash}.json`);
  }

  private transcriptFile(sessionKey: string): string {
    const hash = this.hashSessionKey(sessionKey);
    return path.join(this.transcriptsDir, `t_${hash}.jsonl`);
  }
}
