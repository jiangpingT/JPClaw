---
name: scrape-hn-titles
description: 抓取 Hacker News 首页标题
---

# scrape-hn-titles

## Purpose
抓取 Hacker News (https://news.ycombinator.com) 首页的文章标题列表。

## Inputs
无需输入参数（默认抓取首页）

## Output
格式化的标题列表，按序号排列。

## Steps
1. 使用 curl 获取 HN 首页 HTML
2. 使用 Python 解析提取标题
3. 输出格式化列表

```python
import urllib.request
import re
import html

url = "https://news.ycombinator.com"

try:
    response = urllib.request.urlopen(url, timeout=10)
    page_html = response.read().decode('utf-8')
    
    # HN 的标题在 <span class="titleline"> 中
    pattern = r'<span class="titleline">.*?<a[^>]*>([^<]+)</a>'
    titles = re.findall(pattern, page_html, re.DOTALL)
    
    print(f"找到 {len(titles)} 个标题：\n")
    for i, title in enumerate(titles, 1):
        clean_title = html.unescape(title.strip())
        print(f"{i}. {clean_title}")
        
except Exception as e:
    print(f"抓取失败: {str(e)}")
```

## Guardrails
- 网络超时设置为 10 秒
- 异常时给出明确错误提示
