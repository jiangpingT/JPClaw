/**
 * apple-notes - 通过 memo CLI 操作 macOS 备忘录
 * 依赖：brew install antoniorodr/memo/memo
 * memo 内部用 osascript，测试在 skill-router 上下文是否可用
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MEMO = '/opt/homebrew/bin/memo';

async function memo(args) {
  const { stdout } = await execFileAsync(MEMO, args, { timeout: 30000 });
  return stdout.trim();
}

function parseNotesList(output) {
  // 格式：" N. Folder - Title" 或 " N. Folder - Title"
  const lines = output.split('\n');
  const notes = [];
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\.\s+(.+?)\s+-\s+(.+)$/);
    if (m) {
      notes.push({ index: parseInt(m[1]), folder: m[2].trim(), title: m[3].trim() });
    }
  }
  return notes;
}

function parseInput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { action: 'list' };
  try { return JSON.parse(text); } catch {
    return { action: 'list' };
  }
}

export async function run(input) {
  const params = parseInput(input);
  const action = String(params.action || 'list').toLowerCase();

  try {
    if (action === 'list') {
      const args = ['notes'];
      if (params.folder) args.push('--folder', params.folder);
      const output = await memo(args);
      const notes = parseNotesList(output);
      if (!notes.length) return '没有找到任何备忘录。';
      const lines = notes.map(n => `${n.index}. 【${n.title}】（${n.folder}）`);
      return `备忘录列表（共 ${notes.length} 条）：\n${lines.join('\n')}`;
    }

    if (action === 'folders') {
      const output = await memo(['notes', '--flist']);
      return `文件夹列表：\n${output}`;
    }

    if (action === 'read') {
      if (!params.noteName && params.index === undefined) return '需要提供 noteName 或 index。';
      let index = params.index;
      if (!index && params.noteName) {
        const listOutput = await memo(['notes']);
        const notes = parseNotesList(listOutput);
        const found = notes.find(n => n.title === params.noteName || n.title.includes(params.noteName));
        if (!found) return `未找到备忘录：「${params.noteName}」`;
        index = found.index;
      }
      const output = await memo(['notes', '--view', String(index)]);
      return output || '（内容为空）';
    }

    if (action === 'search') {
      if (!params.query) return '搜索需要提供 query 参数。';
      const listOutput = await memo(['notes']);
      const notes = parseNotesList(listOutput);
      const q = params.query.toLowerCase();
      const matched = notes.filter(n => n.title.toLowerCase().includes(q));
      if (!matched.length) return `未找到包含「${params.query}」的备忘录。`;
      const lines = matched.map(n => `${n.index}. 【${n.title}】（${n.folder}）`);
      return `找到 ${matched.length} 条备忘录：\n${lines.join('\n')}`;
    }

    return `不支持的操作：${action}。\n支持：list / folders / read / search\n（create/delete 需交互，暂不支持）`;

  } catch (err) {
    return `执行失败：${err.message}`;
  }
}
