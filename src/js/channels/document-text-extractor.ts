/**
 * 文档文本提取器
 *
 * 支持格式：
 * - 纯文本：txt, md, json, csv, log
 * - PDF：pdftotext → strings fallback → Vision（扫描件兜底）
 * - DOCX/DOC：pandoc
 * - PPTX：Python3 内置 zipfile 解析 OpenXML（无需额外依赖）
 * - PPT（旧二进制）：不支持（需 LibreOffice）
 * - 图片：Vision API（截图、照片 OCR）
 * - MIME 嗅探：扩展名未知时从字节头自动识别（PDF / DOCX / PPTX）
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDefaultGatewayClient } from "../llm/gateway-client.js";

const execFileAsync = promisify(execFile);

// Vision OCR 提示词（用于扫描版 PDF 和图片）
const OCR_PROMPT =
  "请提取这张图片中所有可见的文字内容（OCR）。如果是文档页面，请逐段输出完整内容，保留原始格式结构；如果是截图，请描述界面并提取所有文字。";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

// 图片预处理限制：超出则缩图压缩
const MAX_IMAGE_PX    = 1600;       // 最大边长（像素），Vision 够用且不超时
const MAX_IMAGE_BYTES = 1_048_576;  // 1 MB，base64 后约 1.4 MB，网关安全范围内

export type ExtractResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * 从文件中提取文本内容（自动识别格式，图片/扫描件走 Vision API）
 */
export async function extractText(filePath: string): Promise<ExtractResult> {
  let ext = path.extname(filePath).toLowerCase();

  try {
    // MIME 嗅探：扩展名未知时从文件字节头自动识别
    if (!ext || ext === ".bin") {
      const sniffed = await sniffExtension(filePath);
      if (sniffed) ext = sniffed;
    }

    // 1. 纯文本文件：直接读取
    if ([".txt", ".md", ".json", ".csv", ".log"].includes(ext)) {
      const text = fs.readFileSync(filePath, "utf-8").trim();
      if (!text) return { ok: false, reason: "empty_text" };
      return { ok: true, text };
    }

    // 2. PDF：pdftotext → strings → Vision（扫描件兜底）
    if (ext === ".pdf") {
      const viaPdfToText = await tryPdfToText(filePath);
      if (viaPdfToText) return { ok: true, text: viaPdfToText };

      const viaStrings = await tryStringsText(filePath);
      if (viaStrings) return { ok: true, text: viaStrings };

      // 扫描版 PDF：转图片后走 Vision OCR
      const viaVision = await tryPdfVision(filePath);
      if (viaVision) return { ok: true, text: viaVision };

      return { ok: false, reason: "pdf_text_extractor_unavailable" };
    }

    // 3. DOCX/DOC：pandoc
    if (ext === ".docx" || ext === ".doc") {
      const viaPandoc = await tryPandocText(filePath);
      if (viaPandoc) return { ok: true, text: viaPandoc };
      return { ok: false, reason: "docx_text_extractor_unavailable" };
    }

    // 4. PPTX：Python3 + zipfile 解析 OpenXML
    if (ext === ".pptx") {
      const viaPython = await tryPptxText(filePath);
      if (viaPython) return { ok: true, text: viaPython };
      return { ok: false, reason: "pptx_text_extractor_failed" };
    }

    // 5. PPT 旧二进制格式：需要 LibreOffice，暂不支持
    if (ext === ".ppt") {
      return { ok: false, reason: "ppt_binary_unsupported" };
    }

    // 6. 图片（截图/照片）：Vision API OCR
    if (IMAGE_EXTS.has(ext)) {
      const viaVision = await tryImageVision(filePath, ext);
      if (viaVision) return { ok: true, text: viaVision };
      return { ok: false, reason: "image_vision_failed" };
    }

    // 7. 其他格式：不支持
    return { ok: false, reason: `unsupported_ext:${ext || "unknown"}` };
  } catch {
    return { ok: false, reason: "extract_error" };
  }
}

// ─── MIME 嗅探 ────────────────────────────────────────────────────────────────

/**
 * 从文件字节头识别真实格式（用于无扩展名或 .bin 的文件）
 */
async function sniffExtension(filePath: string): Promise<string | null> {
  try {
    const buf = Buffer.alloc(8);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);

    // PDF magic: %PDF-
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
      return ".pdf";
    }

    // ZIP magic: PK\x03\x04（Office Open XML / PPTX / DOCX / XLSX 都是 ZIP）
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
      return await sniffZipOfficeType(filePath);
    }

    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";

    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";

    // GIF: GIF8
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return ".gif";

    // WebP: RIFF....WEBP
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return ".webp";
  } catch { /* 读取失败忽略 */ }
  return null;
}

/**
 * ZIP 包内部嗅探：通过 [Content_Types].xml 区分 PPTX / DOCX / XLSX
 */
async function sniffZipOfficeType(filePath: string): Promise<string | null> {
  const script = [
    "import zipfile, sys",
    "try:",
    "    with zipfile.ZipFile(sys.argv[1]) as z:",
    "        ct = z.read('[Content_Types].xml').decode('utf-8', errors='ignore')",
    "        if 'presentationml' in ct: print('pptx')",
    "        elif 'wordprocessingml' in ct: print('docx')",
    "        elif 'spreadsheetml' in ct: print('xlsx')",
    "        else: print('zip')",
    "except: print('zip')",
  ].join("\n");

  try {
    const { stdout } = await execFileAsync("python3", ["-c", script, filePath]);
    const type = stdout.trim();
    return type && type !== "zip" ? `.${type}` : null;
  } catch {
    return null;
  }
}

// ─── 格式提取器 ────────────────────────────────────────────────────────────────

async function tryPdfToText(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("pdftotext", [filePath, "-"]);
    const text = String(stdout || "").trim();
    return text.length > 200 ? text : null;
  } catch {
    return null;
  }
}

async function tryStringsText(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("strings", [filePath]);
    const lines = String(stdout || "")
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 20)
      .filter((x) => !x.startsWith("%PDF-"))
      .filter((x) => !/^\/(Type|Subtype|Length|Filter|Producer|CreationDate)\b/.test(x));

    const text = lines.join("\n").trim();
    return text.length >= 200 ? text : null;
  } catch {
    return null;
  }
}

async function tryPandocText(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("pandoc", [filePath, "-t", "plain"]);
    const text = String(stdout || "").trim();
    return text.length > 50 ? text : null;
  } catch {
    return null;
  }
}

async function tryPptxText(filePath: string): Promise<string | null> {
  const script = [
    "import zipfile, re, sys",
    "path = sys.argv[1]",
    "texts = []",
    "with zipfile.ZipFile(path) as z:",
    "    for name in sorted(z.namelist()):",
    "        if name.startswith('ppt/slides/slide') and name.endswith('.xml'):",
    "            content = z.read(name).decode('utf-8', errors='ignore')",
    "            found = re.findall(r'<a:t>([^<]*)</a:t>', content)",
    "            texts.extend(t for t in found if t.strip())",
    "print('\\n'.join(texts))",
  ].join("\n");

  try {
    const { stdout } = await execFileAsync("python3", ["-c", script, filePath]);
    const text = String(stdout || "").trim();
    return text.length > 20 ? text : null;
  } catch {
    return null;
  }
}

// ─── 图片预处理（EXIF 旋转 + 缩图 + 质量压缩）────────────────────────────────

/**
 * 用 Python Pillow 对图片做预处理：
 *   1. 自动应用 EXIF 旋转（手机拍照防侧倒）
 *   2. 缩放到 MAX_IMAGE_PX 以内
 *   3. 转换为 JPEG（统一格式，压缩率高）
 *   4. 多级质量压降，确保文件 ≤ MAX_IMAGE_BYTES
 * 返回处理后的临时 JPEG 路径（调用方负责清理）。
 * 预处理失败时 fallback 到原始路径（不中断流程）。
 */
async function preprocessImage(srcPath: string): Promise<{ path: string; cleanup: boolean }> {
  const outPath = `/tmp/docext-img-${Date.now()}.jpg`;

  // 用 ImageOps.exif_transpose 自动处理所有 8 种 EXIF 方向
  const script = [
    "import sys, os",
    "from PIL import Image, ImageOps",
    "src, dst, max_px, max_bytes = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])",
    "img = ImageOps.exif_transpose(Image.open(src))",
    "w, h = img.size",
    "if max(w, h) > max_px:",
    "    scale = max_px / max(w, h)",
    "    img = img.resize((int(w*scale), int(h*scale)), Image.LANCZOS)",
    "if img.mode not in ('RGB',):",
    "    bg = Image.new('RGB', img.size, (255,255,255))",
    "    if 'A' in img.getbands(): bg.paste(img, mask=img.getchannel('A'))",
    "    else: bg.paste(img.convert('RGB'))",
    "    img = bg",
    "for q in [85, 75, 65, 55, 45]:",
    "    img.save(dst, 'JPEG', quality=q, optimize=True)",
    "    if os.path.getsize(dst) <= max_bytes: break",
  ].join("\n");

  try {
    await execFileAsync("python3", [
      "-c", script, srcPath, outPath,
      String(MAX_IMAGE_PX), String(MAX_IMAGE_BYTES),
    ]);
    return { path: outPath, cleanup: true };
  } catch {
    // Pillow 预处理失败（不常见），fallback 到原始文件
    try { fs.unlinkSync(outPath); } catch { /* 忽略 */ }
    return { path: srcPath, cleanup: false };
  }
}

// ─── Vision API（图片 / 扫描版 PDF）──────────────────────────────────────────

/**
 * 图片文件 → 预处理（EXIF + 缩图）→ base64 data URI → Vision API OCR
 */
async function tryImageVision(filePath: string, _ext: string): Promise<string | null> {
  const processed = await preprocessImage(filePath);
  try {
    const buf = fs.readFileSync(processed.path);
    const dataUri = `data:image/jpeg;base64,${buf.toString("base64")}`;
    const client = getDefaultGatewayClient();
    return await client.understandImage(dataUri, OCR_PROMPT);
  } catch {
    return null;
  } finally {
    if (processed.cleanup) {
      try { fs.unlinkSync(processed.path); } catch { /* 忽略 */ }
    }
  }
}

/**
 * 扫描版 PDF → pdftoppm 转 JPEG（前3页，150 DPI）→ Vision API OCR
 * PDF 页面无 EXIF 问题，直接输出 JPEG，跳过 Pillow 预处理。
 */
async function tryPdfVision(filePath: string): Promise<string | null> {
  const prefix = `/tmp/docext-${Date.now()}`;
  const pngDir = path.dirname(prefix);
  const pngBase = path.basename(prefix);

  try {
    // -jpeg: 直接输出 JPEG（比 PNG 小很多）；-r 150: 150 DPI；-l 3: 最多3页
    await execFileAsync("pdftoppm", ["-jpeg", "-r", "150", "-l", "3", filePath, prefix]);

    const jpgFiles = fs.readdirSync(pngDir)
      .filter((f) => f.startsWith(pngBase) && f.endsWith(".jpg"))
      .sort()
      .slice(0, 3);

    if (jpgFiles.length === 0) return null;

    const client = getDefaultGatewayClient();
    const pageTexts: string[] = [];

    for (const f of jpgFiles) {
      const jpgPath = path.join(pngDir, f);
      try {
        const buf = fs.readFileSync(jpgPath);
        const dataUri = `data:image/jpeg;base64,${buf.toString("base64")}`;
        const text = await client.understandImage(dataUri, OCR_PROMPT);
        if (text) pageTexts.push(text);
      } finally {
        try { fs.unlinkSync(jpgPath); } catch { /* 忽略清理失败 */ }
      }
    }

    return pageTexts.length > 0 ? pageTexts.join("\n\n---\n\n") : null;
  } catch {
    // 清理可能残留的 JPEG 文件
    try {
      fs.readdirSync(pngDir)
        .filter((f) => f.startsWith(pngBase) && f.endsWith(".jpg"))
        .forEach((f) => { try { fs.unlinkSync(path.join(pngDir, f)); } catch { /* 忽略 */ } });
    } catch { /* 忽略 */ }
    return null;
  }
}
