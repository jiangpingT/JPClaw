/**
 * peer-ask skill
 *
 * 允许 Bot 以自身身份向指定频道发送协作请求，请求同伴 Bot 帮忙。
 * 依赖环境变量 DMWORK_BOT{n}_AGENT / DMWORK_BOT{n}_TOKEN 查找发送方凭证。
 */

export async function run(input) {
  let params;
  try {
    params = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    return JSON.stringify({ error: "输入格式错误：需要 JSON，包含 from_bot_id、to_channel_id、message" });
  }

  const { from_bot_id, to_channel_id, message } = params ?? {};

  if (!from_bot_id || !to_channel_id || !message) {
    return JSON.stringify({ error: "缺少必填字段：from_bot_id、to_channel_id、message 均不能为空" });
  }

  // 查找发送方 Bot 的凭证（遍历 DMWORK_BOT{n}_AGENT）
  const apiUrl = process.env.DMWORK_API_URL || "https://im-test.xming.ai/api";
  let botToken = null;

  for (let i = 1; i <= 10; i++) {
    const agentId = process.env[`DMWORK_BOT${i}_AGENT`];
    if (agentId === from_bot_id) {
      botToken = process.env[`DMWORK_BOT${i}_TOKEN`];
      break;
    }
  }

  if (!botToken) {
    return JSON.stringify({
      error: `未找到 Bot "${from_bot_id}" 的凭证。请检查 DMWORK_BOT{n}_AGENT 环境变量是否正确配置。`
    });
  }

  // 发送消息到目标群组频道
  try {
    const resp = await fetch(`${apiUrl}/v1/bot/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "token": botToken,
      },
      body: JSON.stringify({
        channel_id:   to_channel_id,
        channel_type: 2,              // 2 = 群组
        payload: { type: 1, content: message },
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      return JSON.stringify({ error: `API 错误 ${resp.status}: ${body}` });
    }

    return JSON.stringify({
      success: true,
      message: `已以 "${from_bot_id}" 身份发送协作请求到频道 ${to_channel_id}`,
      note: "同伴 Bot 会在该频道看到此消息并自主决定是否回复"
    });
  } catch (err) {
    return JSON.stringify({ error: `发送失败：${String(err)}` });
  }
}
