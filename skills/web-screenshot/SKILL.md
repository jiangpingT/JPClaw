---
skill: web-screenshot
description: 快速截图工具。专注于打开网页并保存截图，不进行任何交互操作。适用于"截图XX网站"、"保存XX网页"、"网页快照"等纯截图需求。如需填表、点击等交互请用browser-automation技能
input: 
  url: 要截图的网页URL
  output: 截图保存路径（可选，默认为当前目录）
---

# 网页截图技能

使用 Playwright 打开网页并截图。

## 依赖检查与安装

```bash
# 检查 Python 是否可用
python3 --version || python --version

# 安装 Playwright（如果未安装）
pip3 install playwright 2>/dev/null || pip install playwright

# 安装浏览器
playwright install chromium --with-deps 2>/dev/null || python3 -m playwright install chromium --with-deps || python -m playwright install chromium --with-deps
```

## 执行截图

```python
import sys
from playwright.sync_api import sync_playwright
import os
from datetime import datetime

url = """{{url}}"""
output_path = """{{output}}""" if """{{output}}""" else None

# 如果没有指定输出路径，使用默认命名
if not output_path:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = f"screenshot_{timestamp}.png"

print(f"正在打开网页: {url}")

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1920, 'height': 1080})
        page.goto(url, wait_until='networkidle', timeout=30000)
        
        # 等待页面完全加载
        page.wait_for_timeout(2000)
        
        # 截图
        page.screenshot(path=output_path, full_page=True)
        browser.close()
        
        abs_path = os.path.abspath(output_path)
        print(f"✓ 截图已保存: {abs_path}")
        sys.exit(0)
        
except Exception as e:
    print(f"✗ 截图失败: {str(e)}")
    sys.exit(1)
```
