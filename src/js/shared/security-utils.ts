/**
 * P1-9: 安全工具模块
 * 提供输入验证、清理和注入攻击防护
 */

import path from "node:path";
import { log } from "./logger.js";

/**
 * 路径遍历攻击防护
 * 确保文件路径在允许的基础目录内
 */
export function sanitizePath(userPath: string, baseDir: string): string | null {
  // 移除危险字符
  const cleaned = userPath.replace(/\0/g, '');

  // 解析为绝对路径
  const resolved = path.resolve(baseDir, cleaned);

  // 确保结果路径在 baseDir 内（防止 ../ 攻击）
  const normalizedBase = path.resolve(baseDir);
  if (!resolved.startsWith(normalizedBase)) {
    log("warn", "security.path_traversal_attempt", {
      userPath,
      baseDir,
      resolved
    });
    return null;
  }

  return resolved;
}

/**
 * 文件名验证
 * 只允许安全的文件名字符
 */
export function validateFileName(filename: string): boolean {
  // 只允许: 字母、数字、下划线、连字符、点
  // 不允许: 路径分隔符、null字符、控制字符
  const safePattern = /^[a-zA-Z0-9._-]+$/;

  if (!safePattern.test(filename)) {
    log("warn", "security.invalid_filename", { filename });
    return false;
  }

  // 拒绝以点开头的文件（隐藏文件）
  if (filename.startsWith('.')) {
    log("warn", "security.hidden_file_rejected", { filename });
    return false;
  }

  // 拒绝双扩展名（如 file.pdf.exe）
  const parts = filename.split('.');
  if (parts.length > 2) {
    log("warn", "security.double_extension_rejected", { filename });
    return false;
  }

  return true;
}

/**
 * SQL 字符串转义（用于手工构造SQL时）
 * 注意：优先使用参数化查询，这只是备用方案
 */
export function escapeSqlString(str: string): string {
  // 替换单引号为两个单引号（SQL标准转义）
  return str.replace(/'/g, "''");
}

/**
 * HTML 实体编码（防止XSS）
 */
export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Shell 命令参数验证
 * 检查是否包含危险的 shell 元字符
 */
export function validateShellArg(arg: string): boolean {
  // 危险的 shell 元字符
  const dangerousChars = /[;&|`$(){}[\]<>*?~!#\\]/;

  if (dangerousChars.test(arg)) {
    log("warn", "security.dangerous_shell_char", { arg });
    return false;
  }

  return true;
}

/**
 * URL 验证
 * 只允许 http/https 协议
 */
export function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // 只允许 http 和 https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      log("warn", "security.invalid_url_protocol", {
        url,
        protocol: parsed.protocol
      });
      return false;
    }

    // 拒绝本地地址（防止 SSRF）
    const hostname = parsed.hostname.toLowerCase();
    const localHosts = [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '::1',
      '[::]'
    ];

    if (localHosts.includes(hostname) || hostname.startsWith('192.168.') || hostname.startsWith('10.')) {
      log("warn", "security.local_url_rejected", { url, hostname });
      return false;
    }

    return true;
  } catch {
    log("warn", "security.malformed_url", { url });
    return false;
  }
}

/**
 * 用户ID验证
 * 确保用户ID格式安全
 */
export function validateUserId(userId: string): boolean {
  // 只允许字母、数字、下划线、连字符、冒号（用于复合ID）
  const safePattern = /^[a-zA-Z0-9_:-]+$/;

  if (!safePattern.test(userId)) {
    log("warn", "security.invalid_user_id", { userId });
    return false;
  }

  // 限制长度（防止DoS）
  if (userId.length > 200) {
    log("warn", "security.user_id_too_long", {
      userId: userId.substring(0, 50) + '...',
      length: userId.length
    });
    return false;
  }

  return true;
}

/**
 * 整数验证（防止NaN、Infinity等）
 */
export function validateInteger(value: unknown, min?: number, max?: number): number | null {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return null;
  }

  if (!Number.isInteger(num)) {
    return null;
  }

  if (min !== undefined && num < min) {
    return null;
  }

  if (max !== undefined && num > max) {
    return null;
  }

  return num;
}

/**
 * 字符串长度限制
 * 防止过长输入导致DoS
 */
export function limitStringLength(str: string, maxLength: number): string {
  if (str.length > maxLength) {
    log("warn", "security.string_truncated", {
      originalLength: str.length,
      maxLength
    });
    return str.substring(0, maxLength);
  }
  return str;
}

/**
 * 白名单验证
 * 确保值在允许的列表中
 */
export function validateWhitelist<T extends string>(
  value: string,
  whitelist: readonly T[]
): T | null {
  if (whitelist.includes(value as T)) {
    return value as T;
  }

  log("warn", "security.value_not_in_whitelist", {
    value,
    whitelist: whitelist.join(', ')
  });

  return null;
}

/**
 * JSON 安全解析
 * 防止原型污染攻击
 */
export function safeJsonParse(json: string, maxDepth: number = 10): any {
  try {
    const parsed = JSON.parse(json);

    // 检查深度（防止深度嵌套导致DoS）
    function checkDepth(obj: any, depth: number): boolean {
      if (depth > maxDepth) {
        return false;
      }

      if (typeof obj === 'object' && obj !== null) {
        for (const value of Object.values(obj)) {
          if (!checkDepth(value, depth + 1)) {
            return false;
          }
        }
      }

      return true;
    }

    if (!checkDepth(parsed, 0)) {
      log("warn", "security.json_too_deep", { maxDepth });
      return null;
    }

    // 删除 __proto__ 和 constructor 属性（防止原型污染）
    function sanitizeObject(obj: any): void {
      if (typeof obj !== 'object' || obj === null) {
        return;
      }

      delete obj.__proto__;
      delete obj.constructor;

      for (const value of Object.values(obj)) {
        sanitizeObject(value);
      }
    }

    sanitizeObject(parsed);

    return parsed;
  } catch (error) {
    log("warn", "security.json_parse_failed", {
      error: String(error)
    });
    return null;
  }
}
