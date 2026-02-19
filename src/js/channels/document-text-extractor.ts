/**
 * 文档文本提取器
 *
 * 支持格式：
 * - 纯文本：txt, md, json, csv, log
 * - PDF：使用 pdftotext 或 strings 命令提取
 * - DOCX/DOC：使用 pandoc 提取（需要系统安装 pandoc）
 * - 未来可扩展：pptx, xlsx 等
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ExtractResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * 从文件中提取文本内容
 */
export async function extractText(filePath: string): Promise<ExtractResult> {
  const ext = path.extname(filePath).toLowerCase();

  try {
    // 1. 纯文本文件：直接读取
    if ([".txt", ".md", ".json", ".csv", ".log"].includes(ext)) {
      const text = fs.readFileSync(filePath, "utf-8").trim();
      if (!text) {
        return { ok: false, reason: "empty_text" };
      }
      return { ok: true, text };
    }

    // 2. PDF 文件：使用 pdftotext 或 strings
    if (ext === ".pdf") {
      const viaPdfToText = await tryPdfToText(filePath);
      if (viaPdfToText) {
        return { ok: true, text: viaPdfToText };
      }

      const viaStrings = await tryStringsText(filePath);
      if (viaStrings) {
        return { ok: true, text: viaStrings };
      }

      return { ok: false, reason: "pdf_text_extractor_unavailable" };
    }

    // 3. DOCX 文件：使用 pandoc 提取
    if (ext === ".docx" || ext === ".doc") {
      const viaPandoc = await tryPandocText(filePath);
      if (viaPandoc) {
        return { ok: true, text: viaPandoc };
      }

      return { ok: false, reason: "docx_text_extractor_unavailable" };
    }

    // 4. 其他格式：暂不支持
    return { ok: false, reason: `unsupported_ext:${ext || "unknown"}` };
  } catch (error) {
    return { ok: false, reason: "extract_error" };
  }
}

/**
 * 使用 pdftotext 提取 PDF 文本（需要系统安装 poppler-utils）
 */
async function tryPdfToText(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("pdftotext", [filePath, "-"]);
    const text = String(stdout || "").trim();
    if (text.length > 200) {
      return text;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 使用 strings 命令提取 PDF 中的可读文本（fallback）
 */
async function tryStringsText(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("strings", [filePath]);
    const lines = String(stdout || "")
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 20) // 过滤太短的行
      .filter((x) => !x.startsWith("%PDF-")) // 过滤 PDF 头
      .filter((x) => !/^\/(Type|Subtype|Length|Filter|Producer|CreationDate)\b/.test(x)); // 过滤元数据

    const text = lines.join("\n").trim();
    if (text.length < 200) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

/**
 * 使用 pandoc 提取 DOCX 文本（需要系统安装 pandoc）
 */
async function tryPandocText(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("pandoc", [filePath, "-t", "plain"]);
    const text = String(stdout || "").trim();
    if (text.length > 50) {
      return text;
    }
    return null;
  } catch {
    return null;
  }
}
