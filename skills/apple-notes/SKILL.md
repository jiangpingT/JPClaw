---
name: apple-notes
description: Apple 备忘录管理工具。在 macOS 上管理苹果备忘录（Apple Notes），支持列出笔记、查看文件夹、按名称搜索、读取笔记内容。适用于"查看备忘录"、"列出笔记"、"搜索XX笔记"、"查看笔记内容"等请求。仅支持 macOS，需授予终端自动化控制 Notes.app 的权限。依赖：memo（brew install antoniorodr/memo/memo）。
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "os": ["darwin"],
        "requires": { "bins": ["memo"] }
      }
  }
---

# Apple Notes

通过 memo CLI 操作 macOS 备忘录。

## 输入

JSON 字符串，包含 `action` 字段：

```json
{"action": "list"}
{"action": "list", "folder": "Notes"}
{"action": "folders"}
{"action": "read", "noteName": "笔记标题"}
{"action": "read", "index": 3}
{"action": "search", "query": "关键词"}
```

## 支持的操作

- `list` - 列出所有备忘录（默认）
- `folders` - 列出所有文件夹
- `read` - 读取指定笔记内容（通过 noteName 或 index）
- `search` - 按标题关键词搜索备忘录
