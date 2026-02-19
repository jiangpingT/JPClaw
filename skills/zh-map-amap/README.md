# map-poi - 地图POI查询技能

通过高德地图API查询指定位置附近的兴趣点（餐厅、理发店、便利店等）。

## 快速开始

### 1. 申请高德地图API Key（免费）

1. 访问 https://console.amap.com/dev/key/app
2. 注册/登录高德开放平台
3. 创建应用 → 添加Key（选择"Web服务"）
4. 复制你的Key

### 2. 配置API Key

**推荐方式：添加到项目 .env 文件（服务运行时生效）**

```bash
# 手动编辑 .env 文件，添加：
AMAP_API_KEY=your_actual_key_here

# 或者在 Discord/对话中让 AI 帮你配置（推荐）
# "请帮我配置高德地图 API Key: your_actual_key_here"
# AI 会自动调用 update_env_config 工具

# 配置后重启服务
npm run restart
```

**临时测试方式（仅当前终端会话有效）**

```bash
export AMAP_API_KEY="your_actual_key_here"
node skills/map-poi/test.js
```

⚠️ **不推荐**：写入 ~/.zshrc（服务运行时不会加载）

### 3. 测试技能

```bash
# 方法1：运行测试文件
node skills/map-poi/test.js

# 方法2：直接运行技能
node skills/map-poi/index.js

# 方法3：通过JPClaw调用
# 在对话中输入：
# "帮我查找北京市朝阳区望京北路1号附近的理发店"
```

## 使用示例

### 示例1：在对话中使用

```
用户：帮我查找明略科技北京望京办公室附近的理发店

阿策：正在为您查询...
找到 8 个附近的理发店：

1. **木北造型(望京店)**
   📍 北京市朝阳区望京SOHO T1座1层
   🚶 距离：520米
   📞 010-12345678

2. **星客多国际造型**
   📍 北京市朝阳区望京凯德MALL 3层
   🚶 距离：680米
   📞 010-87654321

...
```

### 示例2：通过run_skill调用

```javascript
// 在代码中调用
const result = await run({
  address: "北京市朝阳区望京北路1号中国数码港大厦",
  keyword: "理发店",
  radius: 1000,
  limit: 10
});

console.log(result.summary);
```

### 示例3：文本格式输入

```javascript
const result = await run("上海市浦东新区陆家嘴环路1000号 附近的 川菜");
```

## API说明

### 输入参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| address | string | ✅ | - | 起始地址 |
| keyword | string | ✅ | - | 搜索关键词（餐厅/理发店/咖啡店等） |
| radius | number | ❌ | 1000 | 搜索半径（米） |
| city | string | ❌ | 自动识别 | 城市名称（提高精度） |
| limit | number | ❌ | 10 | 返回结果数量（最大20） |

### 输出格式

```json
{
  "success": true,
  "origin_address": "北京市朝阳区望京北路1号中国数码港大厦",
  "origin_location": "116.48,40.00",
  "keyword": "理发店",
  "total": 8,
  "results": [
    {
      "name": "木北造型(望京店)",
      "address": "北京市朝阳区望京SOHO T1座",
      "distance": 520,
      "phone": "010-12345678",
      "type": "生活服务;美容美发店;美发店",
      "location": "116.481,40.001"
    }
  ],
  "summary": "找到 8 个附近的理发店：\n\n1. **木北造型(望京店)**\n..."
}
```

## 常见问题

### Q1: 提示"未配置高德地图API Key"

**A:** 按照上面"配置API Key"步骤设置环境变量。

### Q2: 提示"无法解析地址"

**A:** 地址不够详细，请提供完整地址（包含省市区街道）。

### Q3: 搜索结果为空

**A:** 尝试：
1. 扩大搜索半径（radius: 2000）
2. 更换关键词（如"理发"改为"美发"）
3. 确认地址是否正确

### Q4: API调用失败

**A:** 检查：
1. API Key是否正确
2. 是否超出免费配额（每日30万次）
3. 网络连接是否正常

### Q5: 想要更精确的结果

**A:** 添加city参数：
```json
{
  "address": "望京北路1号",
  "keyword": "理发店",
  "city": "北京"
}
```

## 技术细节

- **地理编码**：使用高德地图地理编码API（v3/geocode/geo）
- **POI检索**：使用周边搜索API（v3/place/around）
- **限流保护**：单次最多20个结果
- **排序规则**：按距离从近到远排序
- **免费额度**：每日30万次调用（个人开发者Key）

## 扩展开发

### 添加备用API（百度地图）

编辑 `index.js`，在 `geocode()` 和 `searchPOI()` 中添加fallback逻辑：

```javascript
// 如果高德失败，尝试百度
if (!location && process.env.BAIDU_API_KEY) {
  location = await geocodeBaidu(address, process.env.BAIDU_API_KEY);
}
```

### 添加距离计算

```javascript
export async function calculateDistance(fromAddress, toAddress) {
  const loc1 = await geocode(fromAddress, '', apiKey);
  const loc2 = await geocode(toAddress, '', apiKey);
  // 计算两点距离...
}
```

### 添加路线规划

集成高德地图路径规划API（v3/direction/driving）。

## 许可证

MIT License

## 反馈

如有问题或建议，请提交Issue或联系开发者。
