---
name: camsnap
description: 摄像头抓拍工具。从 RTSP/ONVIF 摄像头抓取画面或视频片段。支持摄像头发现、快照抓拍、视频录制、动作监控。适用于"抓拍摄像头"、"录制视频"、"摄像头监控"、"拍照XX摄像头"等查询。需要 ffmpeg，支持配置多个摄像头。
homepage: https://camsnap.ai
metadata:
  {
    "openclaw":
      {
        "emoji": "📸",
        "requires": { "bins": ["camsnap"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/camsnap",
              "bins": ["camsnap"],
              "label": "Install camsnap (brew)",
            },
          ],
      },
  }
---

# camsnap

Use `camsnap` to grab snapshots, clips, or motion events from configured cameras.

Setup

- Config file: `~/.config/camsnap/config.yaml`
- Add camera: `camsnap add --name kitchen --host 192.168.0.10 --user user --pass pass`

Common commands

- Discover: `camsnap discover --info`
- Snapshot: `camsnap snap kitchen --out shot.jpg`
- Clip: `camsnap clip kitchen --dur 5s --out clip.mp4`
- Motion watch: `camsnap watch kitchen --threshold 0.2 --action '...'`
- Doctor: `camsnap doctor --probe`

Notes

- Requires `ffmpeg` on PATH.
- Prefer a short test capture before longer clips.
