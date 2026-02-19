/**
 * apple-reminders - 通过 osascript JXA 操作 macOS 提醒事项
 * 无需安装第三方 CLI，依赖 macOS 内置 osascript
 *
 * 权限：系统设置 → 隐私与安全 → 提醒事项，授予终端访问权限
 */

import { exec } from 'node:child_process';

// ─── osascript 执行器 ────────────────────────────────────────────────────────

function runJXA(script) {
  return new Promise((resolve, reject) => {
    const child = exec(
      'osascript -l JavaScript',
      { timeout: 15000, maxBuffer: 1024 * 1024 },
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
  if (!text) return { action: 'today' };
  try {
    return JSON.parse(text);
  } catch {
    return { action: 'today', query: text };
  }
}

// ─── JXA 脚本生成 ────────────────────────────────────────────────────────────

function jxaListLists() {
  return `
    const app = Application('Reminders');
    const lists = app.lists().map(l => {
      const pending = l.reminders.whose({ completed: false })().length;
      return { id: l.id(), name: l.name(), pending };
    });
    JSON.stringify(lists);
  `;
}

function jxaGetReminders(listName, filter) {
  // listName 和 filter 均通过 JSON.stringify 安全嵌入
  return `
    const app = Application('Reminders');
    const listName = ${JSON.stringify(listName || '')};
    const filter   = ${JSON.stringify(filter || 'pending')};

    const now        = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd   = new Date(todayStart.getTime() + 86400000);
    const weekEnd    = new Date(todayStart.getTime() + 7 * 86400000);

    const targetLists = listName
      ? (() => { try { return [app.lists.byName(listName)]; } catch(e) { return []; } })()
      : app.lists();

    const results = [];
    for (const list of targetLists) {
      let reminders;
      try { reminders = list.reminders(); } catch(e) { continue; }

      for (const r of reminders) {
        const completed = r.completed();
        const dueDate   = r.dueDate() ? r.dueDate().toISOString() : null;

        if (filter === 'today') {
          if (completed) continue;
          if (!dueDate) continue;
          const d = new Date(dueDate);
          if (d < todayStart || d >= todayEnd) continue;
        } else if (filter === 'upcoming') {
          if (completed) continue;
          if (!dueDate) continue;
          const d = new Date(dueDate);
          if (d < now || d >= weekEnd) continue;
        } else if (filter === 'overdue') {
          if (completed) continue;
          if (!dueDate) continue;
          if (new Date(dueDate) >= todayStart) continue;
        } else if (filter === 'pending') {
          if (completed) continue;
        } else if (filter === 'completed') {
          if (!completed) continue;
        }
        // filter === 'all'：不过滤

        results.push({
          id:        r.id(),
          name:      r.name(),
          listName:  list.name(),
          completed,
          dueDate
        });
      }
    }
    JSON.stringify(results);
  `;
}

function jxaCreateReminder(title, listName, due) {
  return `
    const app      = Application('Reminders');
    const listName = ${JSON.stringify(listName || '')};
    const title    = ${JSON.stringify(title)};
    const dueStr   = ${JSON.stringify(due || '')};

    let targetList;
    if (listName) {
      try { targetList = app.lists.byName(listName); }
      catch(e) { throw new Error('列表不存在：' + listName); }
    } else {
      targetList = app.defaultList();
    }

    const props = { name: title };
    if (dueStr) props.dueDate = new Date(dueStr);

    app.make({ new: 'reminder', at: targetList.reminders, withProperties: props });
    JSON.stringify({ success: true, list: targetList.name() });
  `;
}

function jxaCompleteReminder(reminderId, reminderName, listName) {
  return `
    const app          = Application('Reminders');
    const reminderId   = ${JSON.stringify(reminderId || '')};
    const reminderName = ${JSON.stringify(reminderName || '')};
    const listName     = ${JSON.stringify(listName || '')};

    const targetLists = listName
      ? (() => { try { return [app.lists.byName(listName)]; } catch(e) { return []; } })()
      : app.lists();

    let found = false;
    outer: for (const list of targetLists) {
      const reminders = list.reminders();
      for (const r of reminders) {
        const match = reminderId ? r.id() === reminderId : r.name() === reminderName;
        if (match) {
          r.completed = true;
          found = true;
          break outer;
        }
      }
    }
    JSON.stringify({ success: found });
  `;
}

function jxaDeleteReminder(reminderId, reminderName, listName) {
  return `
    const app          = Application('Reminders');
    const reminderId   = ${JSON.stringify(reminderId || '')};
    const reminderName = ${JSON.stringify(reminderName || '')};
    const listName     = ${JSON.stringify(listName || '')};

    const targetLists = listName
      ? (() => { try { return [app.lists.byName(listName)]; } catch(e) { return []; } })()
      : app.lists();

    let found = false;
    outer: for (const list of targetLists) {
      const reminders = list.reminders();
      for (const r of reminders) {
        const match = reminderId ? r.id() === reminderId : r.name() === reminderName;
        if (match) {
          app.delete(r);
          found = true;
          break outer;
        }
      }
    }
    JSON.stringify({ success: found });
  `;
}

// ─── 输出格式化 ──────────────────────────────────────────────────────────────

function formatReminder(r) {
  const check = r.completed ? '[x]' : '[ ]';
  const due   = r.dueDate
    ? `  到期：${new Date(r.dueDate).toLocaleString('zh-CN')}`
    : '';
  return `${check} ${r.name}${due ? '\n' + due : ''}\n    列表：${r.listName}`;
}

function handlePermissionError(err) {
  const msg = err.message || '';
  if (
    msg.includes('not authorized') ||
    msg.includes('-1743') ||
    msg.includes('not allowed') ||
    msg.includes('权限')
  ) {
    return '权限不足。请在 系统设置 → 隐私与安全 → 提醒事项 中授予终端访问权限，然后重试。';
  }
  return null;
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function run(input) {
  const params = parseInput(input);
  const action = String(params.action || 'today').toLowerCase();

  try {
    // 列出清单
    if (action === 'lists') {
      const raw   = await runJXA(jxaListLists());
      const lists = JSON.parse(raw);
      if (!lists.length) return '没有找到任何提醒事项清单。';
      const lines = lists.map(l => `- ${l.name}（${l.pending} 条未完成）`);
      return `提醒事项清单（共 ${lists.length} 个）：\n${lines.join('\n')}`;
    }

    // 查询提醒
    const filterMap = {
      today: 'today', upcoming: 'upcoming', overdue: 'overdue',
      pending: 'pending', completed: 'completed', all: 'all',
      list: params.filter || 'pending'
    };
    if (filterMap[action] !== undefined) {
      const raw       = await runJXA(jxaGetReminders(params.listName, filterMap[action]));
      const reminders = JSON.parse(raw);
      if (!reminders.length) return '没有找到符合条件的提醒事项。';
      const lines = reminders.map(formatReminder);
      return `找到 ${reminders.length} 条提醒：\n\n${lines.join('\n\n')}`;
    }

    // 创建提醒
    if (action === 'create') {
      if (!params.title) return '创建提醒需要 title 参数。';
      const raw  = await runJXA(jxaCreateReminder(params.title, params.listName, params.due));
      const data = JSON.parse(raw);
      const due  = params.due ? `，到期：${new Date(params.due).toLocaleString('zh-CN')}` : '';
      return data.success
        ? `已创建提醒：「${params.title}」（清单：${data.list}）${due}`
        : '创建失败。';
    }

    // 完成提醒
    if (action === 'complete') {
      if (!params.reminderId && !params.reminderName) return '需要提供 reminderId 或 reminderName。';
      const raw  = await runJXA(jxaCompleteReminder(params.reminderId, params.reminderName, params.listName));
      const data = JSON.parse(raw);
      const label = params.reminderName || params.reminderId;
      return data.success ? `已完成提醒：「${label}」` : `未找到提醒：「${label}」`;
    }

    // 删除提醒
    if (action === 'delete') {
      if (!params.reminderId && !params.reminderName) return '需要提供 reminderId 或 reminderName。';
      const raw  = await runJXA(jxaDeleteReminder(params.reminderId, params.reminderName, params.listName));
      const data = JSON.parse(raw);
      const label = params.reminderName || params.reminderId;
      return data.success ? `已删除提醒：「${label}」` : `未找到提醒：「${label}」`;
    }

    return `不支持的操作：${action}。\n支持：lists / today / upcoming / overdue / pending / completed / all / list / create / complete / delete`;

  } catch (err) {
    return handlePermissionError(err) || `执行失败：${err.message}`;
  }
}
