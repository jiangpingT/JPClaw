---
name: eightctl
description: Eight Sleep 智能床控制工具。控制 Eight Sleep 睡眠舱的状态、温度、闹钟和时间表。支持开关控制、温度调节、闹钟管理、日程管理、音频控制、床座调节。适用于"调节床温"、"设置闹钟"、"Eight Sleep XX"、"关闭智能床"等查询。需要配置 Eight Sleep 账户。
homepage: https://eightctl.sh
metadata:
  {
    "openclaw":
      {
        "emoji": "🎛️",
        "requires": { "bins": ["eightctl"] },
        "install":
          [
            {
              "id": "go",
              "kind": "go",
              "module": "github.com/steipete/eightctl/cmd/eightctl@latest",
              "bins": ["eightctl"],
              "label": "Install eightctl (go)",
            },
          ],
      },
  }
---

# eightctl

Use `eightctl` for Eight Sleep pod control. Requires auth.

Auth

- Config: `~/.config/eightctl/config.yaml`
- Env: `EIGHTCTL_EMAIL`, `EIGHTCTL_PASSWORD`

Quick start

- `eightctl status`
- `eightctl on|off`
- `eightctl temp 20`

Common tasks

- Alarms: `eightctl alarm list|create|dismiss`
- Schedules: `eightctl schedule list|create|update`
- Audio: `eightctl audio state|play|pause`
- Base: `eightctl base info|angle`

Notes

- API is unofficial and rate-limited; avoid repeated logins.
- Confirm before changing temperature or alarms.
