/**
 * apple-reminders - 通过 remindctl CLI 操作 macOS 提醒事项
 * 依赖：brew install steipete/tap/remindctl
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REMINDCTL = '/opt/homebrew/bin/remindctl';

async function rc(args) {
  const { stdout } = await execFileAsync(REMINDCTL, [...args, '--no-color', '--no-input'], {
    timeout: 30000
  });
  return stdout.trim();
}

async function rcJSON(args) {
  const raw = await rc([...args, '--json']);
  return JSON.parse(raw || '[]');
}

function formatList(l) {
  return `- ${l.title}（${l.reminderCount} 条，${l.overdueCount} 条过期）`;
}

function formatReminder(r) {
  const check = r.isCompleted ? '[x]' : '[ ]';
  const due = r.dueDate
    ? `\n  到期：${new Date(r.dueDate).toLocaleString('zh-CN')}`
    : '';
  return `${check} ${r.title}${due}\n    列表：${r.listName}`;
}

export async function run(input) {
  let params;
  const text = String(input ?? '').trim();
  if (!text) {
    params = { action: 'today' };
  } else {
    try {
      params = JSON.parse(text);
    } catch {
      params = { action: 'today', query: text };
    }
  }

  const action = String(params.action || 'today').toLowerCase();

  try {
    if (action === 'lists') {
      const lists = await rcJSON(['list']);
      if (!lists.length) return '没有找到任何提醒事项清单。';
      return `提醒事项清单（共 ${lists.length} 个）：\n${lists.map(formatList).join('\n')}`;
    }

    const showFilters = ['today', 'tomorrow', 'week', 'overdue', 'upcoming', 'completed', 'all'];
    const filterAlias = { pending: 'all' };
    const filter = filterAlias[action] ?? (showFilters.includes(action) ? action : null);

    if (filter !== null) {
      const args = ['show', filter];
      if (params.listName) args.push('--list', params.listName);
      let reminders = await rcJSON(args);
      if (action === 'pending') reminders = reminders.filter(r => !r.isCompleted);
      if (!reminders.length) return '没有找到符合条件的提醒事项。';
      return `找到 ${reminders.length} 条提醒：\n\n${reminders.map(formatReminder).join('\n\n')}`;
    }

    if (action === 'list') {
      if (!params.listName) return '需要提供 listName 参数。';
      const reminders = await rcJSON(['list', params.listName]);
      if (!reminders.length) return `清单「${params.listName}」没有提醒事项。`;
      return `「${params.listName}」共 ${reminders.length} 条：\n\n${reminders.map(formatReminder).join('\n\n')}`;
    }

    if (action === 'create') {
      if (!params.title) return '创建提醒需要 title 参数。';
      const args = ['add', params.title];
      if (params.listName) args.push('--list', params.listName);
      if (params.due) args.push('--due', params.due);
      if (params.notes) args.push('--notes', params.notes);
      await rc(args);
      const due = params.due ? `，到期：${new Date(params.due).toLocaleString('zh-CN')}` : '';
      const list = params.listName ? `（清单：${params.listName}）` : '';
      return `已创建提醒：「${params.title}」${list}${due}`;
    }

    if (action === 'complete') {
      if (!params.reminderId && !params.reminderName) return '需要提供 reminderId 或 reminderName。';
      const id = params.reminderId || params.reminderName;
      await rc(['complete', id]);
      return `已完成提醒：「${id}」`;
    }

    if (action === 'delete') {
      if (!params.reminderId && !params.reminderName) return '需要提供 reminderId 或 reminderName。';
      const id = params.reminderId || params.reminderName;
      await rc(['delete', id, '--force']);
      return `已删除提醒：「${id}」`;
    }

    return `不支持的操作：${action}。\n支持：lists / today / tomorrow / week / upcoming / overdue / pending / completed / all / list / create / complete / delete`;

  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('not authorized') || msg.includes('-1743') || msg.includes('permission')) {
      return '权限不足。请在 系统设置 → 隐私与安全 → 提醒事项 中授予终端访问权限，然后重试。';
    }
    return `执行失败：${msg}`;
  }
}
