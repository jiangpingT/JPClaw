---
name: apple-notes
description: Apple 备忘录管理工具。通过 osascript JXA 在 macOS 上管理苹果备忘录，支持列出、搜索、创建、读取、删除笔记，支持按文件夹过滤。适用于"添加备忘录"、"查看笔记"、"搜索XX笔记"、"新建备忘录"等查询。仅支持 macOS，需授予终端自动化控制 Notes.app 的权限。
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "os": ["darwin"],
        "requires": { "bins": ["osascript"] }
      }
  }
---

# Apple Notes CLI

Use `memo notes` to manage Apple Notes directly from the terminal. Create, view, edit, delete, search, move notes between folders, and export to HTML/Markdown.

Setup

- Install (Homebrew): `brew tap antoniorodr/memo && brew install antoniorodr/memo/memo`
- Manual (pip): `pip install .` (after cloning the repo)
- macOS-only; if prompted, grant Automation access to Notes.app.

View Notes

- List all notes: `memo notes`
- Filter by folder: `memo notes -f "Folder Name"`
- Search notes (fuzzy): `memo notes -s "query"`

Create Notes

- Add a new note: `memo notes -a`
  - Opens an interactive editor to compose the note.
- Quick add with title: `memo notes -a "Note Title"`

Edit Notes

- Edit existing note: `memo notes -e`
  - Interactive selection of note to edit.

Delete Notes

- Delete a note: `memo notes -d`
  - Interactive selection of note to delete.

Move Notes

- Move note to folder: `memo notes -m`
  - Interactive selection of note and destination folder.

Export Notes

- Export to HTML/Markdown: `memo notes -ex`
  - Exports selected note; uses Mistune for markdown processing.

Limitations

- Cannot edit notes containing images or attachments.
- Interactive prompts may require terminal access.

Notes

- macOS-only.
- Requires Apple Notes.app to be accessible.
- For automation, grant permissions in System Settings > Privacy & Security > Automation.
