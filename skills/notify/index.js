/**
 * Notify Skill
 *
 * 向 Discord + Telegram 推送任意消息。
 * 后台编程任务完成后，用一条 curl 调用即可通知手机。
 */

import { sendToDiscord, sendToTelegram, sendToDmwork } from "../_shared/proactive-utils.js";

const DEFAULT_CHANNEL_ID   = "1469204772379693222";
const DEFAULT_TELEGRAM_ID  = "-1003855994917";
const DEFAULT_DMWORK_ID    = process.env.DMWORK_DEFAULT_CHANNEL_ID || "";

export async function run(input) {
  const params = typeof input === "string" ? JSON.parse(input) : input;
  const {
    message,
    channelId      = DEFAULT_CHANNEL_ID,
    telegramChatId = DEFAULT_TELEGRAM_ID,
    dmworkChannelId = DEFAULT_DMWORK_ID,
  } = params;

  if (!message) {
    return JSON.stringify({ ok: false, error: "message 参数必填" });
  }

  const results = await Promise.allSettled([
    sendToDiscord(channelId, message),
    telegramChatId  ? sendToTelegram(telegramChatId, message)       : Promise.resolve([]),
    dmworkChannelId ? sendToDmwork(dmworkChannelId, message, 2)     : Promise.resolve(null),
  ]);

  return JSON.stringify({
    ok: true,
    discord:  results[0].status === "fulfilled" ? results[0].value : `error: ${results[0].reason}`,
    telegram: results[1].status === "fulfilled" ? results[1].value : `error: ${results[1].reason}`,
    dmwork:   results[2].status === "fulfilled" ? "ok"             : `error: ${results[2].reason}`,
  });
}

export default run;
