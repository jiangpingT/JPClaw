/**
 * Weather (天气查询) Skill
 *
 * 使用高德地图天气 API（国内直连，无需代理）查询城市天气预报。
 * 支持北京（家）和外地两种播报风格。
 */

import fs from "node:fs";
import path from "node:path";
import {
  todayString, ensureDir, BRAIN_DIR,
  callAnthropic,
} from "../_shared/proactive-utils.js";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const HOME_CITY   = "北京";
const WEATHER_DIR = path.join(BRAIN_DIR, "weather");
const AMAP_KEY    = process.env.AMAP_API_KEY || "";
const AMAP_BASE   = "https://restapi.amap.com/v3";

// ─── 昨日缓存 ────────────────────────────────────────────────────────────────

function cachePath(city, dateStr) {
  return path.join(WEATHER_DIR, `${dateStr}-${city}.json`);
}

function loadYesterday(city) {
  try {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const y = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const p = cachePath(city, y);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { return null; }
}

function saveToday(city, data) {
  try {
    ensureDir(WEATHER_DIR);
    fs.writeFileSync(cachePath(city, todayString()), JSON.stringify(data), "utf-8");
  } catch { /* 不影响主流程 */ }
}

// ─── 高德 API 请求 ────────────────────────────────────────────────────────────

async function amapFetch(path_, params) {
  const url = new URL(`${AMAP_BASE}${path_}`);
  url.searchParams.set("key", AMAP_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`高德 API ${path_} 返回 ${res.status}`);
  const json = await res.json();
  if (json.status !== "1") throw new Error(`高德 API 错误: ${json.info}`);
  return json;
}

async function resolveAdcode(cityName) {
  const data = await amapFetch("/config/district", { keywords: cityName, subdistrict: "0" });
  const dist = data.districts?.[0];
  if (!dist) throw new Error(`找不到城市：${cityName}`);
  return { adcode: dist.adcode, name: dist.name };
}

async function fetchWeather(city) {
  const { adcode, name } = await resolveAdcode(city);

  const data = await amapFetch("/weather/weatherInfo", { city: adcode, extensions: "all" });
  const forecast = data.forecasts?.[0];
  if (!forecast) throw new Error("高德天气数据为空");

  const today = forecast.casts?.[0];
  if (!today) throw new Error("今日预报数据为空");

  const minTemp = Number(today.nighttemp ?? 0);
  const maxTemp = Number(today.daytemp   ?? 0);
  const dayWeather   = today.dayweather   ?? "未知";
  const nightWeather = today.nightweather ?? "未知";
  const dayWind      = today.daywind      ?? "";
  const dayPower     = today.daypower     ?? "";

  // 降雨判断（从天气描述推断）
  const rainKeywords = ["雨", "阵雨", "雷", "雪"];
  const hasRain = rainKeywords.some(k => dayWeather.includes(k) || nightWeather.includes(k));

  // 极端天气
  const extremeFlags = [];
  if (minTemp <= -10)              extremeFlags.push(`寒潮（最低 ${minTemp}°C）`);
  if (maxTemp >= 37)               extremeFlags.push(`高温 ${maxTemp}°C`);
  if (dayWeather.includes("暴雨")) extremeFlags.push("暴雨");
  if (dayWeather.includes("大雪")) extremeFlags.push("大雪");
  if (Number(dayPower) >= 7)       extremeFlags.push(`大风（${dayWind}风 ${dayPower}级）`);

  const result = {
    city: name.replace(/市$/, ""),
    dayWeather,
    nightWeather,
    minTemp, maxTemp,
    dayWind, dayPower,
    hasRain,
    extremeFlags,
  };

  // 写今日缓存
  saveToday(city, { minTemp, maxTemp });

  // 读昨日缓存，计算降温幅度
  const yesterday = loadYesterday(city);
  result.yesterdayMin  = yesterday?.minTemp ?? null;
  result.yesterdayMax  = yesterday?.maxTemp ?? null;
  result.tempDrop      = yesterday ? (minTemp - yesterday.minTemp) : null;

  return result;
}

// ─── AI 生成播报 ──────────────────────────────────────────────────────────────

async function generateReport(w, isHome) {
  const lines = [
    `城市：${w.city}`,
    `白天天气：${w.dayWeather}，夜间：${w.nightWeather}`,
    `气温范围：${w.minTemp}°C ~ ${w.maxTemp}°C`,
    `风力：${w.dayWind}风 ${w.dayPower}级`,
    `是否有降水：${w.hasRain ? "是" : "否"}`,
  ];
  if (w.tempDrop !== null) {
    lines.push(`与昨日相比：最低温 ${w.tempDrop >= 0 ? "+" : ""}${w.tempDrop}°C（昨日 ${w.yesterdayMin}~${w.yesterdayMax}°C）`);
  }
  if (w.extremeFlags.length) lines.push(`极端天气：${w.extremeFlags.join("、")}`);

  const homeRules = `
你在播报**北京（家）**的天气，必须依次回答（简洁列点）：
1. 今日温度区间。若最低温降幅 ≥ 5°C，加「⚠️ 明显降温，记得给孩子加衣」
2. 是否需要备伞：有降水则说「需要给孩子备伞」，否则「不用备伞」
3. 有无极端天气（有则用 ⚠️ 标出，无则不提）
4. 穿衣建议：结合温度给大宝（约15岁）和二宝（约7岁）分别给建议，差异不大可合并一句`;

  const travelRules = `
你在播报**外地出差**的天气，只需回答（简洁列点）：
1. 有无极端天气（有则用 ⚠️ 标出，无则不提）
2. 今日穿衣建议（一句话）`;

  const systemPrompt = `你是「阿策」的天气播报模块。根据数据生成简洁天气播报。

${isHome ? homeRules : travelRules}

格式要求：
- 第一行：📍 ${w.city} | ${w.minTemp}°C ~ ${w.maxTemp}°C | ${w.dayWeather}
- 之后列点，每点一行，不超过4行
- 纯文本，不用 markdown 标题
- 不要重复数据，不要废话`;

  return callAnthropic(systemPrompt, lines.join("\n"), { maxTokens: 512 });
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function run(input) {
  try {
    let params = {};
    try { params = typeof input === "string" ? JSON.parse(input) : input || {}; } catch { params = {}; }

    const city   = (params.city || params.location || HOME_CITY).trim();
    const isHome = city === HOME_CITY || city === "北京市";

    const w      = await fetchWeather(city);
    const report = await generateReport(w, isHome);

    // 标准输出格式：result 字段让 extractReadableOutput 能识别
    return JSON.stringify({ ok: true, result: report, city: w.city }, null, 2);
  } catch (error) {
    // 用户友好的错误消息，不暴露技术细节
    const msg = error.message || "未知错误";
    const userMsg = msg.includes("城市") || msg.includes("找不到")
      ? `抱歉，找不到该城市的天气信息，请确认城市名称。`
      : `抱歉，天气查询暂时不可用，请稍后再试。`;
    return JSON.stringify({ ok: false, result: userMsg, error: msg }, null, 2);
  }
}

export default run;
