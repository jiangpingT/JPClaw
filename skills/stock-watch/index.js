/**
 * Stock Watch (收盘行情播报) Skill
 *
 * 每日 17:00 追踪指定股票的市值和当日成交额，
 * 所有金额统一换算成港币，推送到 Telegram/Discord。
 */

import fs from "node:fs";
import path from "node:path";
import {
  runCurl, safeExec, todayString, ensureDir,
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

// 服务以 daemon 运行时 PATH 不含 miniforge/conda，需要动态查找有 yfinance 的 python3
const PYTHON3_CANDIDATES = [
  "/opt/homebrew/Caskroom/miniforge/base/bin/python3",
  "/opt/homebrew/opt/python3/bin/python3",
  "/usr/local/bin/python3",
  "/usr/bin/python3",
];
let _python3Path = null;

async function resolvePython3() {
  if (_python3Path) return _python3Path;
  for (const p of PYTHON3_CANDIDATES) {
    try {
      await safeExec(p, ["-c", "import yfinance"], { timeout: 5_000 });
      _python3Path = p;
      return p;
    } catch {}
  }
  // 最后兜底，用 PATH 里的 python3（大概率没有 yfinance，但也会明确报错）
  _python3Path = "python3";
  return _python3Path;
}

// 用 yfinance 批量拉市值（quoteSummary 需要 crumb，yfinance 内部处理了鉴权）
async function fetchMarketCaps(tickers) {
  const pyCode = `
import sys, json, yfinance as yf
result = {}
for s in sys.argv[1:]:
    try:
        tk = yf.Ticker(s)
        info = tk.info
        mc = info.get('marketCap') or tk.fast_info.market_cap
        curr = info.get('currency') or tk.fast_info.currency
        result[s] = {'marketCap': mc, 'currency': curr}
    except Exception as e:
        result[s] = {'error': str(e)}
print(json.dumps(result))
`.trim();
  try {
    const python3 = await resolvePython3();
    const out = await safeExec(python3, ["-c", pyCode, ...tickers], { timeout: 40_000 });
    return JSON.parse(out);
  } catch (e) {
    console.warn("[stock-watch] fetchMarketCaps 失败:", e.message);
    return {};
  }
}

async function fetchQuote(ticker) {
  const raw = await runCurl(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
    ["-H", "User-Agent: Mozilla/5.0"]
  );
  const m = JSON.parse(raw).chart.result[0].meta;
  return {
    ticker,
    currency: m.currency,                         // "HKD" 或 "USD"
    price: m.regularMarketPrice,                  // 当前价格
    prevClose: m.chartPreviousClose,              // 昨收
    volume: m.regularMarketVolume,                // 成交量（股数）
    dayHigh: m.regularMarketDayHigh,
    dayLow: m.regularMarketDayLow,
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

  // 把日期放在数据里，而非只放系统提示，避免 AI 用数据中的旧日期
  const header = `今日日期：${date}\nUSD/HKD：${usdHkd.toFixed(4)}\n`;
  const dataText = rows.map(r => {
    const mktCap = fmtHkd(r.marketCapHkd);
    const turnover = fmtHkd(r.turnoverHkd);
    const change = fmtChange(r.price, r.prevClose);
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

    const tickers = watchlist.map(s => s.ticker);

    // ① 并行拉行情 + 汇率 + 市值
    const [usdHkdResult, marketCapsResult, ...quoteResults] = await Promise.allSettled([
      fetchUsdHkdRate(),
      fetchMarketCaps(tickers),
      ...watchlist.map(s => fetchQuote(s.ticker)),
    ]);

    const usdHkd = usdHkdResult.status === "fulfilled" ? usdHkdResult.value : 7.78;
    const marketCaps = marketCapsResult.status === "fulfilled" ? marketCapsResult.value : {};

    // ② 组装行数据，统一换算 HKD
    const rows = watchlist.map((stock, i) => {
      const r = quoteResults[i];
      if (r.status !== "fulfilled") {
        return { ...stock, error: r.reason?.message ?? "fetch failed" };
      }
      const q = r.value;
      const mc = marketCaps[stock.ticker];
      const turnoverLocal = (q.price ?? 0) * (q.volume ?? 0);
      const marketCapLocal = mc?.marketCap ?? null;
      return {
        ...stock,
        price:        q.price,
        prevClose:    q.prevClose,
        currency:     q.currency,
        volume:       q.volume,
        turnoverHkd:  toHkd(turnoverLocal, q.currency, usdHkd),
        marketCapHkd: toHkd(marketCapLocal, mc?.currency ?? q.currency, usdHkd),
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
