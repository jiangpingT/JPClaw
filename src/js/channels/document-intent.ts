import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatEngine } from "../core/engine.js";
import { extractText } from "./document-text-extractor.js";

export function looksLikeDocumentSummaryIntent(input: string): boolean {
  const text = String(input || "");
  const hasSummaryVerb = /(总结|概括|提炼|核心内容|要点|摘要|读一下|阅读)/.test(text);
  const hasFileHint =
    /\.[a-z0-9]{2,5}\b/i.test(text) || /文件|pdf|文档|报告|ppt|word|excel/i.test(text);
  return hasSummaryVerb && hasFileHint;
}

export async function maybeHandleDocumentSummaryIntent(
  agent: ChatEngine,
  raw: string,
  context: { userId: string; userName: string; channelId: string; traceId?: string }
): Promise<string | null> {
  if (!looksLikeDocumentSummaryIntent(raw)) return null;
  const fileRef = extractFileRef(raw);
  if (!fileRef) return null;

  const filePath = resolveFilePath(fileRef);
  if (!filePath || !fs.existsSync(filePath)) {
    return `我识别到你在让读文件，但没找到文件：${fileRef}\n请给我绝对路径，或确认文件在 ~/Downloads / ~/Desktop / ~/Documents。`;
  }

  const extracted = await extractText(filePath);
  if (!extracted.ok) {
    return [
      `已定位文件：${filePath}`,
      `但当前环境无法提取可读文本（${extracted.reason}）。`,
      "你可以：",
      "1) 发我该 PDF 的关键页截图/文本片段，我立即总结。",
      "2) 给我可用的文本版（txt/md/docx 导出文本）路径。"
    ].join("\n");
  }

  const prompt = [
    "请基于下面文档内容做中文总结。",
    "输出要求：",
    "1) 先给 3 句核心结论。",
    "2) 再给 5 条关键要点。",
    "3) 最后给 3 条可执行建议。",
    "",
    `文件：${filePath}`,
    "",
    extracted.text.slice(0, 24000)
  ].join("\n");

  const summarized = await agent.reply(prompt, {
    userId: context.userId,
    userName: context.userName,
    channelId: context.channelId,
    traceId: context.traceId
  });
  return String(summarized || "").trim() || `已读取 ${path.basename(filePath)}，但总结结果为空。`;
}

export function extractFileRef(raw: string): string | null {
  const quoted = raw.match(/["“](.+?\.[a-z0-9]{2,5})["”]/i);
  if (quoted?.[1]) return quoted[1].trim();
  const direct = raw.match(/([^\s，。！？、]+\.[a-z0-9]{2,5})/i);
  if (direct?.[1]) return direct[1].trim();
  const fallback = raw.match(/([\w\u4e00-\u9fa5 .()_-]+\.[a-z0-9]{2,5})/i);
  if (!fallback?.[1]) return null;
  const cleaned = fallback[1]
    .replace(/^.*(?:下的|里的|中的)/, "")
    .replace(/^[\s:："'“”]+/, "")
    .trim();
  return cleaned || null;
}

export function resolveFilePath(ref: string): string | null {
  if (path.isAbsolute(ref)) return ref;
  const home = os.homedir();
  const baseDirs = [process.cwd(), path.join(home, "Downloads"), path.join(home, "Desktop"), path.join(home, "Documents")];
  const candidates = [
    path.resolve(process.cwd(), ref),
    path.join(home, "Downloads", ref),
    path.join(home, "Desktop", ref),
    path.join(home, "Documents", ref)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const fuzzy = findFuzzyMatch(baseDirs, ref);
  if (fuzzy) return fuzzy;
  return null;
}

function findFuzzyMatch(baseDirs: string[], ref: string): string | null {
  const target = String(ref || "").trim().toLowerCase();
  if (!target) return null;
  for (const dir of baseDirs) {
    if (!fs.existsSync(dir)) continue;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const found = names
      .filter((name) => name.toLowerCase().endsWith(target) || name.toLowerCase().includes(target))
      .map((name) => path.join(dir, name))
      .find((full) => fs.existsSync(full) && fs.statSync(full).isFile());
    if (found) return found;
  }
  return null;
}

// extractText、tryPdfToText、tryStringsText 已移至 document-text-extractor.ts
