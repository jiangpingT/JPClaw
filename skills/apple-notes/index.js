/**
 * apple-notes - 通过 osascript JXA 操作 macOS 备忘录
 * 无需安装第三方 CLI，依赖 macOS 内置 osascript
 *
 * 权限：系统设置 → 隐私与安全 → 自动化，授予终端控制 Notes.app 的权限
 */

import { exec } from 'node:child_process';

// ─── osascript 执行器 ────────────────────────────────────────────────────────

function runJXA(script) {
  return new Promise((resolve, reject) => {
    const child = exec(
      'osascript -l JavaScript',
      { timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim()));
        } else {
          resolve(stdout.trim());
        }
      }
    );
    child.stdin.write(script);
    child.stdin.end();
  });
}

// ─── 输入解析 ────────────────────────────────────────────────────────────────

function parseInput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { action: 'list' };
  try {
    return JSON.parse(text);
  } catch {
    // 纯文本当作搜索词
    return { action: 'search', query: text };
  }
}

// ─── JXA 脚本生成 ────────────────────────────────────────────────────────────

function jxaListNotes(folderName, limit) {
  const cap = Math.min(Number(limit) || 20, 50);
  return `
    const app        = Application('Notes');
    const folderName = ${JSON.stringify(folderName || '')};
    const limit      = ${cap};

    let notes;
    if (folderName) {
      try {
        notes = app.folders.byName(folderName).notes();
      } catch(e) {
        throw new Error('文件夹不存在：' + folderName);
      }
    } else {
      notes = app.notes();
    }

    const result = notes.slice(0, limit).map(n => {
      let folder = '';
      try { folder = n.container().name(); } catch(e) {}
      return {
        id:      n.id(),
        name:    n.name(),
        folder,
        modDate: n.modificationDate() ? n.modificationDate().toISOString() : null
      };
    });
    JSON.stringify(result);
  `;
}

function jxaSearchNotes(query, limit) {
  const cap = Math.min(Number(limit) || 10, 20);
  return `
    const app   = Application('Notes');
    const query = ${JSON.stringify(String(query).toLowerCase())};
    const limit = ${cap};

    const all     = app.notes();
    const results = [];

    for (const n of all) {
      if (results.length >= limit) break;
      const name = n.name().toLowerCase();
      let plaintext = '';
      try { plaintext = n.plaintext().toLowerCase(); } catch(e) {}

      if (!name.includes(query) && !plaintext.includes(query)) continue;

      let folder = '';
      try { folder = n.container().name(); } catch(e) {}

      // 提取匹配上下文
      let preview = '';
      try {
        const pt  = n.plaintext();
        const idx = pt.toLowerCase().indexOf(query);
        if (idx >= 0) {
          preview = pt.substring(Math.max(0, idx - 40), idx + 80).trim();
        } else {
          preview = pt.substring(0, 80).trim();
        }
      } catch(e) {}

      results.push({ id: n.id(), name: n.name(), folder, preview,
        modDate: n.modificationDate() ? n.modificationDate().toISOString() : null });
    }
    JSON.stringify(results);
  `;
}

function jxaCreateNote(title, body, folderName) {
  // Notes.app 的 body 是 HTML，将纯文本换行转成 <br>
  const htmlBody = String(body || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  return `
    const app        = Application('Notes');
    const folderName = ${JSON.stringify(folderName || '')};
    const title      = ${JSON.stringify(title)};
    const body       = ${JSON.stringify(htmlBody)};

    let target;
    if (folderName) {
      try { target = app.folders.byName(folderName); }
      catch(e) { throw new Error('文件夹不存在：' + folderName); }
    } else {
      // 使用默认账户的默认文件夹
      try {
        target = app.defaultAccount().defaultFolder();
      } catch(e) {
        target = app.folders()[0];
      }
    }

    app.make({ new: 'note', at: target.notes, withProperties: { name: title, body } });
    JSON.stringify({ success: true, folder: target.name() });
  `;
}

function jxaReadNote(noteId, noteName) {
  return `
    const app      = Application('Notes');
    const noteId   = ${JSON.stringify(noteId || '')};
    const noteName = ${JSON.stringify(noteName || '')};

    let note = null;
    if (noteId) {
      try { note = app.notes.byId(noteId); } catch(e) {}
    } else {
      const all = app.notes();
      for (const n of all) {
        if (n.name() === noteName) { note = n; break; }
      }
    }

    if (!note) {
      JSON.stringify({ found: false });
    } else {
      let plaintext = '';
      try { plaintext = note.plaintext(); } catch(e) {}
      let folder = '';
      try { folder = note.container().name(); } catch(e) {}
      JSON.stringify({
        found:   true,
        id:      note.id(),
        name:    note.name(),
        folder,
        modDate: note.modificationDate() ? note.modificationDate().toISOString() : null,
        content: plaintext
      });
    }
  `;
}

function jxaDeleteNote(noteId, noteName) {
  return `
    const app      = Application('Notes');
    const noteId   = ${JSON.stringify(noteId || '')};
    const noteName = ${JSON.stringify(noteName || '')};

    let found = false;
    if (noteId) {
      try { app.delete(app.notes.byId(noteId)); found = true; } catch(e) {}
    } else {
      const all = app.notes();
      for (const n of all) {
        if (n.name() === noteName) { app.delete(n); found = true; break; }
      }
    }
    JSON.stringify({ success: found });
  `;
}

// ─── 权限错误检测 ────────────────────────────────────────────────────────────

function handlePermissionError(err) {
  const msg = err.message || '';
  if (
    msg.includes('not authorized') ||
    msg.includes('-1743') ||
    msg.includes('not allowed') ||
    msg.includes('权限')
  ) {
    return '权限不足。请在 系统设置 → 隐私与安全 → 自动化 中授予终端控制 Notes.app 的权限，然后重试。';
  }
  return null;
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function run(input) {
  const params = parseInput(input);
  const action = String(params.action || 'list').toLowerCase();

  try {
    // 列出笔记
    if (action === 'list') {
      const raw   = await runJXA(jxaListNotes(params.folder, params.limit));
      const notes = JSON.parse(raw);
      if (!notes.length) return '没有找到任何备忘录。';
      const lines = notes.map(n => {
        const date   = n.modDate ? new Date(n.modDate).toLocaleDateString('zh-CN') : '';
        const folder = n.folder ? `（${n.folder}）` : '';
        return `- 【${n.name}】${folder}${date ? '  ' + date : ''}`;
      });
      return `备忘录列表（共 ${notes.length} 条）：\n${lines.join('\n')}`;
    }

    // 搜索笔记
    if (action === 'search') {
      if (!params.query) return '搜索需要提供 query 参数。';
      const raw   = await runJXA(jxaSearchNotes(params.query, params.limit));
      const notes = JSON.parse(raw);
      if (!notes.length) return `未找到包含「${params.query}」的备忘录。`;
      const lines = notes.map(n => {
        const folder  = n.folder ? `（${n.folder}）` : '';
        const preview = n.preview ? `\n  ...${n.preview}...` : '';
        return `- 【${n.name}】${folder}${preview}`;
      });
      return `找到 ${notes.length} 条备忘录：\n\n${lines.join('\n\n')}`;
    }

    // 创建笔记
    if (action === 'create') {
      if (!params.title) return '创建备忘录需要 title 参数。';
      const raw  = await runJXA(jxaCreateNote(params.title, params.body, params.folder));
      const data = JSON.parse(raw);
      return data.success
        ? `已创建备忘录：「${params.title}」（文件夹：${data.folder}）`
        : '创建失败。';
    }

    // 读取笔记
    if (action === 'read') {
      if (!params.noteId && !params.noteName) return '需要提供 noteId 或 noteName。';
      const raw  = await runJXA(jxaReadNote(params.noteId, params.noteName));
      const data = JSON.parse(raw);
      if (!data.found) return '未找到该备忘录。';
      const date   = data.modDate ? new Date(data.modDate).toLocaleString('zh-CN') : '';
      const folder = data.folder ? `（${data.folder}）` : '';
      return [
        `【${data.name}】${folder}`,
        date ? `修改时间：${date}` : '',
        '',
        data.content || '（内容为空）'
      ].filter(l => l !== undefined).join('\n').trim();
    }

    // 删除笔记
    if (action === 'delete') {
      if (!params.noteId && !params.noteName) return '需要提供 noteId 或 noteName。';
      const raw   = await runJXA(jxaDeleteNote(params.noteId, params.noteName));
      const data  = JSON.parse(raw);
      const label = params.noteName || params.noteId;
      return data.success ? `已删除备忘录：「${label}」` : `未找到备忘录：「${label}」`;
    }

    return `不支持的操作：${action}。\n支持：list / search / create / read / delete`;

  } catch (err) {
    return handlePermissionError(err) || `执行失败：${err.message}`;
  }
}
