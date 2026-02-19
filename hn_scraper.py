#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import urllib.request
import re
import sys

try:
    url = 'https://news.ycombinator.com'
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'Mozilla/5.0'}
    )
    
    with urllib.request.urlopen(req, timeout=10) as response:
        html = response.read().decode('utf-8')
    
    # 提取标题 - HN的HTML结构
    pattern = r'<span class="titleline"><a[^>]*>([^<]+)</a>'
    titles = re.findall(pattern, html)
    
    if not titles:
        print("未找到标题，尝试备用模式...")
        # 备用模式
        pattern2 = r'class="titleline"[^>]*>.*?<a[^>]*>([^<]+)</a>'
        titles = re.findall(pattern2, html, re.DOTALL)
    
    if titles:
        print(f"抓取到 {len(titles)} 个标题：\n")
        for i, title in enumerate(titles, 1):
            print(f"{i}. {title.strip()}")
    else:
        print("未能提取到标题")
        
except Exception as e:
    print(f"错误: {e}", file=sys.stderr)
    sys.exit(1)
