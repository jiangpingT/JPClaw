/**
 * Weather (天气查询) Skill
 *
 * 查询指定城市的实时天气，根据场景（北京/外地）输出个性化播报：
 * - 北京（家）：降温对比、是否给孩子备伞、穿衣建议
 * - 外地（出差）：极端天气、穿衣建议
 *
 * 昨日气温从缓存文件读取，每次查询后自动更新缓存。
 */

import fs from "node:fs";
import path from "node:path";
import {
  runCurl, todayString, ensureDir, BRAIN_DIR,
  callAnthropic,
} from "../_shared/proactive-utils.js";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const HOME_CITY   = "北京";
const WEATHER_DIR = path.join(BRAIN_DIR, "weather");

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

// ─── 数据采集 ────────────────────────────────────────────────────────────────

async function fetchWeather(city) {
  const raw = await runCurl(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
  if (!raw?.trim()) throw new Error("wttr.in 返回为空");

  const data    = JSON.parse(raw);
  const current = data.current_condition?.[0];
  const today   = data.weather?.[0];
  if (!current) throw new Error("天气数据结构异常");

  const hourly        = today.hourly ?? [];
  const maxRainChance = Math.max(0, ...hourly.map(h => Number(h.chanceofrain ?? 0)));
  const maxSnowChance = Math.max(0, ...hourly.map(h => Number(h.chanceofsnow ?? 0)));
  const totalPrecipMM = hourly.reduce((s, h) => s + Number(h.precipMM ?? 0), 0);
  const windKmph      = Number(current.windspeedKmph ?? 0);
  const minTemp       = Number(today.mintempC ?? 0);
  const maxTemp       = Number(today.maxtempC ?? 0);

  // 极端天气判断
  const extremeFlags = [];
  if (windKmph >= 60)                              extremeFlags.push(`大风 ${windKmph}km/h`);
  if (maxRainChance >= 70 && totalPrecipMM >= 25)  extremeFlags.push("暴雨");
  if (maxSnowChance >= 60)                         extremeFlags.push("大雪");
  if (minTemp <= -10)                              extremeFlags.push(`寒潮（最低 ${minTemp}°C）`);
  if (maxTemp >= 37)                               extremeFlags.push(`高温 ${maxTemp}°C`);

  const result = {
    city,
    desc:         current.weatherDesc?.[0]?.value ?? "未知",
    temp:         Number(current.temp_C ?? 0),
    feelsLike:    Number(current.FeelsLikeC ?? 0),
    humidity:     current.humidity ?? "--",
    windKmph,
    minTemp, maxTemp,
    maxRainChance,
    totalPrecipMM: Math.round(totalPrecipMM * 10) / 10,
    extremeFlags,
  };

  // 写今日缓存
  saveToday(city, { minTemp, maxTemp });

  // 读昨日缓存，计算降温幅度
  const yesterday = loadYesterday(city);
  result.yesterdayMin  = yesterday?.minTemp ?? null;
  result.yesterdayMax  = yesterday?.maxTemp ?? null;
  result.tempDrop      = yesterday ? (minTemp - yesterday.minTemp) : null; // 负数 = 降温

  return result;
}

// ─── AI 生成播报 ──────────────────────────────────────────────────────────────

async function generateReport(w, isHome) {
  // 把结构化数据转成文本送给 AI，减少幻觉
  const lines = [
    `城市：${w.city}`,
    `天气：${w.desc}`,
    `今日温度：${w.minTemp}°C ~ ${w.maxTemp}°C，体感 ${w.feelsLike}°C`,
    `风速：${w.windKmph} km/h，湿度：${w.humidity}%`,
    `降雨概率：${w.maxRainChance}%，总降水：${w.totalPrecipMM}mm`,
  ];
  if (w.tempDrop !== null) {
    lines.push(`与昨日相比：最低温 ${w.tempDrop >= 0 ? "+" : ""}${w.tempDrop}°C（昨日 ${w.yesterdayMin}~${w.yesterdayMax}°C）`);
  }
  if (w.extremeFlags.length) lines.push(`极端天气：${w.extremeFlags.join("、")}`);

  const homeRules = `
你在播报**北京（家）**的天气，必须依次回答以下问题（简洁列点）：
1. 今日温度区间。若与昨日相比最低温降幅 ≥ 5°C，加一句「⚠️ 明显降温，记得给孩子加衣」
2. 是否需要备伞：降雨概率 ≥ 40% 时说「需要给孩子备伞」，否则说「不用备伞」
3. 有无极端天气（有则用 ⚠️ 标出，无则不提）
4. 穿衣建议：结合温度给大宝（约15岁）和二宝（约7岁）分别给建议，如果差异不大可合并一句`;

  const travelRules = `
你在播报**出差外地**的天气，只需回答（简洁列点）：
1. 有无极端天气（有则用 ⚠️ 标出，无则不提）
2. 今日穿衣建议（一句话）`;

  const systemPrompt = `你是「阿策」的天气播报模块。根据数据生成简洁天气播报。

${isHome ? homeRules : travelRules}

格式要求：
- 第一行：📍 ${w.city} | ${w.minTemp}°C ~ ${w.maxTemp}°C | ${w.desc}
- 之后列点，每点一行，不超过4行
- 纯文本，适配 Telegram，不用 markdown 标题
- 不要重复数据，不要废话`;

  return callAnthropic(systemPrompt, lines.join("\n"), { maxTokens: 512 });
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function run(input) {
  try {
    let params = {};
    try { params = typeof input === "string" ? JSON.parse(input) : input || {}; } catch { params = {}; }

    const city   = (params.city || params.location || HOME_CITY).trim();
    const isHome = city === HOME_CITY;

    const w      = await fetchWeather(city);
    const report = await generateReport(w, isHome);

    return JSON.stringify({ ok: true, city, isHome, report }, null, 2);
  } catch (error) {
    return JSON.stringify({ ok: false, error: error.message }, null, 2);
  }
}

export default run;
