import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatEngine } from "../core/engine.js";
import type { ChannelConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";

type FeishuEventEnvelope = {
  challenge?: string;
  type?: string;
  token?: string;
  encrypt?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    token?: string;
  };
  event?: {
    sender?: {
      sender_id?: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      sender_type?: string;
    };
    message?: {
      message_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
    };
  };
};

type FeishuTextEvent = {
  eventId?: string;
  messageId: string;
  chatId: string;
  fromUser: string;
  content: string;
};

let cachedTenantToken: { value: string; expiresAt: number } | null = null;
const seenEventIds = new Map<string, number>();
const FEISHU_WORK_TIMEOUT_MS = Number(process.env.FEISHU_WORK_TIMEOUT_MS || "4500");
const FEISHU_FINAL_TIMEOUT_MS = Number(process.env.FEISHU_FINAL_TIMEOUT_MS || "45000");
const FEISHU_DEDUPE_WINDOW_MS = Number(process.env.FEISHU_DEDUPE_WINDOW_MS || "300000");
const FEISHU_FORCE_DIRECT_STYLE = process.env.FEISHU_FORCE_DIRECT_STYLE !== "false";

export async function handleFeishuWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  config: ChannelConfig | undefined,
  agent: ChatEngine
): Promise<void> {
  if (!config?.enabled) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "feishu_disabled" }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const rawBody = await readRawBody(req);
  if (!verifyFeishuSignature(req, rawBody, config)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_signature" }));
    return;
  }

  let payload: FeishuEventEnvelope;
  try {
    payload = JSON.parse(rawBody.toString("utf-8")) as FeishuEventEnvelope;
  } catch (error) {
    log("warn", "feishu.webhook.invalid_json", { error: String(error) });
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  if (payload.challenge || payload.type === "url_verification") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ challenge: payload.challenge || "" }));
    return;
  }

  if (config.verificationToken) {
    const token = payload?.header?.token || payload?.token;
    if (token && token !== config.verificationToken) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_token" }));
      return;
    }
  }

  // Keep callback fast to avoid Feishu retries.
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: 0 }));

  if (payload.encrypt) {
    log("warn", "feishu.event.encrypted_unsupported");
    return;
  }

  const eventType = payload?.header?.event_type || payload?.type || "";
  if (eventType !== "im.message.receive_v1") {
    log("info", "feishu.event.received", { eventType });
    return;
  }

  const textEvent = parseTextEvent(payload);
  if (!textEvent || !textEvent.content.trim()) return;

  const dedupeId = textEvent.eventId || textEvent.messageId;
  if (isDuplicateEvent(dedupeId)) return;

  log("info", "feishu.message.received", {
    eventType,
    hasEventId: Boolean(textEvent.eventId),
    hasMessageId: Boolean(textEvent.messageId)
  });

  setImmediate(() => {
    void processFeishuEvent(agent, config, textEvent);
  });
}

export async function sendFeishuPing(
  config: ChannelConfig | undefined,
  options: { chatId?: string; text?: string }
): Promise<{ ok: boolean; detail: string }> {
  if (!config?.enabled) return { ok: false, detail: "feishu_disabled" };
  const text = normalizeReply(options.text || "Ping from JPClaw");
  if (!text) return { ok: false, detail: "empty_text" };
  if (!options.chatId) return { ok: false, detail: "missing_chat_id" };
  try {
    await sendChatMessage(config, options.chatId, text);
    return { ok: true, detail: "chat_sent" };
  } catch (error) {
    return { ok: false, detail: String(error) };
  }
}

async function processFeishuEvent(
  agent: ChatEngine,
  config: ChannelConfig,
  event: FeishuTextEvent
): Promise<void> {
  try {
    const input = FEISHU_FORCE_DIRECT_STYLE ? buildDirectFeishuPrompt(event.content) : event.content;
    const replyPromise = agent
      .reply(input, {
        userId: `feishu:${event.fromUser}`,
        userName: event.fromUser,
        channelId: `feishu:${event.chatId}`
      })
      .then((text) => String(text || ""))
      .catch((error) => {
        log("warn", "feishu.reply.failed", { error: String(error) });
        return "";
      });

    const fast = await withTimeout(replyPromise, FEISHU_WORK_TIMEOUT_MS).catch(() => "");
    if (fast.trim()) {
      await sendFeishuReply(config, event.chatId, fast);
      return;
    }

    await sendFeishuReply(config, event.chatId, "收到，我在处理。");

    const final = await withTimeout(replyPromise, FEISHU_FINAL_TIMEOUT_MS).catch(() => "");
    if (final.trim()) {
      await sendFeishuReply(config, event.chatId, final);
    } else {
      log("warn", "feishu.reply.timeout", { hasChatId: true });
    }
  } catch (error) {
    log("error", "feishu.process.failed", { error: String(error) });
  }
}

function parseTextEvent(payload: FeishuEventEnvelope): FeishuTextEvent | null {
  const msg = payload?.event?.message;
  const sender = payload?.event?.sender?.sender_id;
  const messageType = (msg?.message_type || "").toLowerCase();
  if (messageType !== "text") return null;

  const rawContent = msg?.content || "";
  let text = "";
  try {
    const parsed = JSON.parse(rawContent) as { text?: string };
    text = String(parsed.text || "");
  } catch {
    text = rawContent;
  }

  const messageId = msg?.message_id || "";
  const chatId = msg?.chat_id || "";
  const fromUser = sender?.open_id || sender?.user_id || sender?.union_id || "";
  if (!messageId || !chatId || !fromUser) return null;

  return {
    eventId: payload?.header?.event_id || undefined,
    messageId,
    chatId,
    fromUser,
    content: text.trim()
  };
}

async function sendFeishuReply(config: ChannelConfig, chatId: string, output: string): Promise<void> {
  const text = normalizeReply(output);
  if (!text) return;
  const chunks = splitForFeishu(text, 1600);
  for (const chunk of chunks) {
    await sendChatMessage(config, chatId, chunk);
  }
}

async function sendChatMessage(config: ChannelConfig, chatId: string, text: string): Promise<void> {
  const token = await getTenantAccessToken(config);
  const resp = await fetch(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text })
      })
    }
  );

  const json = (await resp.json()) as { code?: number; msg?: string };
  if (!resp.ok || (json.code ?? 0) !== 0) {
    log("warn", "feishu.send.failed", { ok: resp.ok, code: json.code, msg: json.msg });
    throw new Error(`feishu_send_failed:${json.code}:${json.msg || "unknown"}`);
  }
}

async function getTenantAccessToken(config: ChannelConfig): Promise<string> {
  if (!config.appId || !config.appSecret) {
    throw new Error("feishu_missing_app_id_or_secret");
  }
  if (cachedTenantToken && cachedTenantToken.expiresAt > Date.now() + 10_000) {
    return cachedTenantToken.value;
  }

  const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      app_id: config.appId,
      app_secret: config.appSecret
    })
  });

  const json = (await resp.json()) as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (!resp.ok || (json.code ?? 0) !== 0 || !json.tenant_access_token) {
    log("warn", "feishu.gettoken.failed", { ok: resp.ok, code: json.code, msg: json.msg });
    throw new Error(`feishu_gettoken_failed:${json.code}:${json.msg || "unknown"}`);
  }

  cachedTenantToken = {
    value: json.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, Number(json.expire || 7200) - 60) * 1000
  };
  return cachedTenantToken.value;
}

function verifyFeishuSignature(req: IncomingMessage, rawBody: Buffer, config: ChannelConfig): boolean {
  if (!config.encryptKey) return true;
  const timestamp = getHeader(req, "x-lark-request-timestamp");
  const nonce = getHeader(req, "x-lark-request-nonce");
  const signature = getHeader(req, "x-lark-signature");
  if (!timestamp || !nonce || !signature) return false;

  const base = `${timestamp}${nonce}${config.encryptKey}`;
  const hash = crypto
    .createHash("sha256")
    .update(Buffer.concat([Buffer.from(base, "utf8"), rawBody]))
    .digest("hex");

  return hash === signature;
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (error) => reject(error));
  });
}

function normalizeReply(text: string): string {
  const normalized = text.trim();
  if (!normalized) return "";
  return normalized;
}

function splitForFeishu(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.6)) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function isDuplicateEvent(eventId: string): boolean {
  const now = Date.now();
  const expiresAt = seenEventIds.get(eventId);
  if (expiresAt && expiresAt > now) return true;
  if (seenEventIds.size > 2000) {
    for (const [key, exp] of seenEventIds.entries()) {
      if (exp <= now) seenEventIds.delete(key);
    }
  }
  seenEventIds.set(eventId, now + FEISHU_DEDUPE_WINDOW_MS);
  return false;
}

function buildDirectFeishuPrompt(content: string): string {
  return [
    "请直接回答用户问题，不要反问，不要列出可选项，不要自我说明。",
    "输出简洁中文，优先给结论和要点，控制在 6-10 条以内。",
    content.trim()
  ]
    .filter(Boolean)
    .join("\n");
}
