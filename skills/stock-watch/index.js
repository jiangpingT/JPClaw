/**
 * Stock Watch (收盘行情播报) Skill
 *
 * 每日 17:00 追踪指定股票的市值和当日成交额，
 * 所有金额统一换算成港币，推送到 Telegram/Discord。
 *
 * 数据来源：东方财富 API（f116=总市值，f48=成交额，含 WVR 双重股权结构修正）
 */

import fs from "node:fs";
import path from "node:path";
import {
  runCurl, todayString, ensureDir,
  callAnthropic, sendToDiscord, sendToTelegram, BRAIN_DIR,
} from "../_shared/proactive-utils.js";

// ─── 自选股配置 ──────────────────────────────────────────────────────────────

const DEFAULT_WATCHLIST = [
  { name: "MiniMax",  ticker: "0100.HK", market: "港股" },
  { name: "智谱AI",   ticker: "2513.HK", market: "港股" },
  { name: "AppLovin", ticker: "APP",     market: "美股" },
  { name: "Palantir", ticker: "PLTR",    market: "美股" },
  { name: "商汤科技", ticker: "0020.HK", market: "港股" },
  { name: "明略科技", ticker: "2718.HK", market: "港股" },
];

const STOCK_DIR = path.join(BRAIN_DIR, "stocks");

// ─── 数据采集 ────────────────────────────────────────────────────────────────

async function fetchUsdHkdRate() {
  try {
    const raw = await runCurl(
      "https://query1.finance.yahoo.com/v8/finance/chart/USDHKD=X?interval=1d&range=1d",
      ["-H", "User-Agent: Mozilla/5.0"]
    );
    const m = JSON.parse(raw).chart.result[0].meta;
    return m.regularMarketPrice ?? 7.78;
  } catch {
    return 7.78; // 汇率兜底值
  }
}

/**
 * 将 ticker 转为东方财富 secid 格式
 * 港股：0100.HK → 116.00100（f116 单位 HKD）
 * 美股：APP → 105.APP（f116 单位 USD，NASDAQ/NYSE 均用 105）
 */
function tickerToSecid(ticker) {
  if (ticker.endsWith(".HK")) {
    const code = ticker.replace(".HK", "").padStart(5, "0");
    return { secid: `116.${code}`, currency: "HKD" };
  }
  return { secid: `105.${ticker}`, currency: "USD" };
}

/**
 * 从东方财富拉取单只股票的完整行情。
 * f43=最新价, f44=最高, f45=最低, f47=成交量(股), f48=成交额(本币),
 * f60=昨收, f116=总市值(本币，含 WVR 双重股权修正)
 */
async function fetchEastmoney(ticker) {
  const { secid, currency } = tickerToSecid(ticker);
  const fields = "f43,f44,f45,f46,f47,f48,f60,f116";
  const url = `https://push2.eastmoney.com/api/qt/stock/get?invt=2&fltt=2&fields=${fields}&secid=${secid}`;
  const raw = await runCurl(url, [
    "-H", "Referer: https://quote.eastmoney.com/",
    "-H", "User-Agent: Mozilla/5.0",
  ]);
  const d = JSON.parse(raw)?.data;
  if (!d || d.f43 == null) throw new Error(`东方财富无数据: ${ticker}`);
  return {
    ticker,
    currency,
    price:     d.f43,   // 最新价
    prevClose: d.f60,   // 昨收
    dayHigh:   d.f44,   // 当日最高
    dayLow:    d.f45,   // 当日最低
    volume:    d.f47,   // 成交量（股数）
    turnover:  d.f48,   // 成交额（本币，HKD 或 USD）
    marketCap: d.f116,  // 总市值（含 WVR 双重股权，本币）
  };
}

// ─── 换算与格式化 ─────────────────────────────────────────────────────────────

function toHkd(value, currency, usdHkd) {
  if (value == null) return null;
  return currency === "USD" ? value * usdHkd : value;
}

function fmtHkd(value) {
  if (value == null) return "N/A";
  if (value >= 1e12) return `HK$${(value / 1e12).toFixed(2)}万亿`;
  if (value >= 1e8)  return `HK$${(value / 1e8).toFixed(2)}亿`;
  if (value >= 1e4)  return `HK$${(value / 1e4).toFixed(2)}万`;
  return `HK$${value.toFixed(2)}`;
}

function fmtChange(price, prevClose) {
  if (!price || !prevClose) return "";
  const pct = ((price - prevClose) / prevClose) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

// ─── AI 生成报告 ──────────────────────────────────────────────────────────────

async function generateReport(rows, usdHkd, date) {
  const systemPrompt = `你是「阿策」的股票播报模块。根据提供的原始行情数据，
生成一份简洁的收盘播报，格式如下（纯文本，适配 Telegram）：

📊 **自选股收盘播报** | ${date}
💱 USD/HKD：${usdHkd.toFixed(4)}

[每只股票一行，格式：emoji 名称(代码) 价格 涨跌幅 | 市值 | 成交额]

---
🤖 JPClaw 自动生成

规则：
- 涨用 🟢，跌用 🔴，平用 ⚪
- 金额全部用港币，缩写（亿/万亿）
- 简洁，不加多余评论
- 如果某只股票数据缺失，标注「数据不可用」`;

  const header = `今日日期：${date}\nUSD/HKD：${usdHkd.toFixed(4)}\n`;
  const dataText = rows.map(r => {
    const mktCap  = fmtHkd(r.marketCapHkd);
    const turnover = fmtHkd(r.turnoverHkd);
    const change   = fmtChange(r.price, r.prevClose);
    return `${r.name}(${r.ticker}) | 价格:${r.price ?? "N/A"} ${r.currency} | 涨跌:${change} | 市值:${mktCap} | 成交额:${turnover}`;
  }).join("\n");

  return callAnthropic(systemPrompt, header + dataText, { maxTokens: 1024 });
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function run(input) {
  try {
    let params = {};
    try { params = typeof input === "string" ? JSON.parse(input) : input || {}; } catch { params = {}; }

    const watchlist      = params.watchlist      || DEFAULT_WATCHLIST;
    const channelId      = params.channelId      || process.env.DEFAULT_DISCORD_CHANNEL_ID;
    const telegramChatId = params.telegramChatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;
    const date = todayString();

    // ① 并行拉汇率 + 各股行情（东方财富一站式提供价格/成交额/市值）
    const [usdHkdResult, ...stockResults] = await Promise.allSettled([
      fetchUsdHkdRate(),
      ...watchlist.map(s => fetchEastmoney(s.ticker)),
    ]);

    const usdHkd = usdHkdResult.status === "fulfilled" ? usdHkdResult.value : 7.78;

    // ② 组装行数据，统一换算 HKD
    const rows = watchlist.map((stock, i) => {
      const r = stockResults[i];
      if (r.status !== "fulfilled") {
        return { ...stock, error: r.reason?.message ?? "fetch failed" };
      }
      const q = r.value;
      return {
        ...stock,
        price:        q.price,
        prevClose:    q.prevClose,
        currency:     q.currency,
        volume:       q.volume,
        turnoverHkd:  toHkd(q.turnover,   q.currency, usdHkd),
        marketCapHkd: toHkd(q.marketCap,  q.currency, usdHkd),
        dayHigh:      q.dayHigh,
        dayLow:       q.dayLow,
      };
    });

    // ③ AI 生成报告
    const reportContent = await generateReport(rows, usdHkd, date);

    // ④ 持久化
    ensureDir(STOCK_DIR);
    const reportPath = path.join(STOCK_DIR, `${date}-stocks.md`);
    fs.writeFileSync(reportPath, reportContent, "utf-8");

    // ⑤ 推送
    let discordMessageIds = [];
    if (channelId) {
      try { discordMessageIds = await sendToDiscord(channelId, reportContent); }
      catch (e) { discordMessageIds = [`error: ${e.message}`]; }
    }

    let telegramMessageIds = [];
    if (telegramChatId) {
      try { telegramMessageIds = await sendToTelegram(telegramChatId, reportContent); }
      catch (e) { telegramMessageIds = [`error: ${e.message}`]; }
    }

    return JSON.stringify({
      ok: true, date, usdHkd,
      stocks: rows.length,
      reportPath,
      discordMessageIds,
      telegramMessageIds,
    }, null, 2);
  } catch (error) {
    return JSON.stringify({ ok: false, error: error.message }, null, 2);
  }
}

export default run;
