import { EventEmitter } from "node:events";

export interface DashboardEvent {
  type: "chat_message" | "bot_thinking" | "bot_done";
  timestamp: number;
  channelId?: string;
  // chat_message
  author?: string;
  content?: string;
  isBot?: boolean;
  // bot_thinking / bot_done
  botName?: string;
  botId?: string;
}

class DashboardBus extends EventEmitter {
  private recentKeys = new Set<string>();

  emit(event: "message", data: DashboardEvent): boolean {
    // chat_message 去重：相同 channelId+author+content 2秒内只推一次
    if (data.type === "chat_message") {
      const key = `${data.channelId}:${data.author}:${(data.content ?? "").slice(0, 80)}`;
      if (this.recentKeys.has(key)) return false;
      this.recentKeys.add(key);
      setTimeout(() => this.recentKeys.delete(key), 2000);
    }
    return super.emit(event, data);
  }
}

export const dashboardBus = new DashboardBus();
