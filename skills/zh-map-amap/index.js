/**
 * map-poi - 高德地图POI检索技能
 * 支持周边搜索、关键词检索、距离计算
 */

export async function run(input) {
  // 1. 解析输入
  const params = parseInput(input);

  // 2. 检查API密钥
  const apiKey = process.env.AMAP_API_KEY;
  if (!apiKey) {
    return formatError('API_KEY_MISSING',
      '未配置高德地图API Key。\n' +
      '请访问 https://console.amap.com/dev/key/app 申请，然后设置：\n' +
      'export AMAP_API_KEY="your_key_here"'
    );
  }

  try {
    // 3. 地理编码：地址 → 经纬度
    const location = await geocode(params.address, params.city, apiKey);
    if (!location) {
      return formatError('GEOCODE_FAILED',
        `无法解析地址：${params.address}\n请提供更详细的地址信息。`
      );
    }

    // 4. POI检索
    const pois = await searchPOI(
      location,
      params.keyword,
      params.radius,
      params.limit,
      apiKey
    );

    // 5. 格式化输出
    const result = formatResults(params.address, location, params.keyword, pois);

    // 6. 返回用户友好的文本摘要（而不是 JSON）
    return wrapOutput(result);

  } catch (error) {
    return formatError('API_ERROR', error.message);
  }
}

/**
 * 包装输出：如果调用者需要纯文本，返回 summary；否则返回完整 JSON
 */
function wrapOutput(result) {
  // 如果是错误对象，返回错误消息
  if (!result.success) {
    return result.message || JSON.stringify(result, null, 2);
  }

  // 对于成功的结果，返回用户友好的摘要文本
  return result.summary || JSON.stringify(result, null, 2);
}

/**
 * 解析输入参数
 */
function parseInput(input) {
  // 如果是JSON对象
  if (typeof input === 'object' && input !== null) {
    return {
      address: input.address || '',
      keyword: input.keyword || '',
      radius: input.radius || 1000,
      city: input.city || '',
      limit: Math.min(input.limit || 10, 20)
    };
  }

  // 如果是字符串，尝试解析
  const text = String(input);
  
  // 尝试JSON解析
  try {
    const json = JSON.parse(text);
    return parseInput(json);
  } catch {}

  // 文本格式解析："地址 附近的 关键词"
  const match = text.match(/(.+?)\s*附近的?\s*(.+)/);
  if (match) {
    return {
      address: match[1].trim(),
      keyword: match[2].trim(),
      radius: 1000,
      city: '',
      limit: 10
    };
  }

  return {
    address: text,
    keyword: '',
    radius: 1000,
    city: '',
    limit: 10
  };
}

/**
 * 地理编码：地址转经纬度
 */
async function geocode(address, city, apiKey) {
  const url = new URL('https://restapi.amap.com/v3/geocode/geo');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('address', address);
  if (city) {
    url.searchParams.set('city', city);
  }

  const response = await fetch(url.toString());
  const data = await response.json();

  if (data.status !== '1' || !data.geocodes || data.geocodes.length === 0) {
    return null;
  }

  return data.geocodes[0].location; // 返回 "116.48,40.00" 格式
}

/**
 * POI周边搜索
 */
async function searchPOI(location, keyword, radius, limit, apiKey) {
  const url = new URL('https://restapi.amap.com/v3/place/around');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('location', location);
  url.searchParams.set('keywords', keyword);
  url.searchParams.set('radius', String(radius));
  url.searchParams.set('offset', String(limit));
  url.searchParams.set('extensions', 'all'); // 返回详细信息

  const response = await fetch(url.toString());
  const data = await response.json();

  if (data.status !== '1') {
    throw new Error(`高德API错误: ${data.info}`);
  }

  return data.pois || [];
}

/**
 * 格式化结果
 */
function formatResults(address, location, keyword, pois) {
  const results = pois.map(poi => ({
    name: poi.name,
    address: poi.address,
    distance: parseInt(poi.distance) || 0,
    phone: poi.tel || '暂无',
    type: poi.type,
    location: poi.location
  }));

  // 按距离排序
  results.sort((a, b) => a.distance - b.distance);

  // 生成用户友好的摘要
  const summary = generateSummary(keyword, results);

  return {
    success: true,
    origin_address: address,
    origin_location: location,
    keyword: keyword,
    total: results.length,
    results: results,
    summary: summary
  };
}

/**
 * 生成摘要文本
 */
function generateSummary(keyword, results) {
  if (results.length === 0) {
    return `未找到附近的${keyword}。建议：\n1. 扩大搜索半径\n2. 更换关键词`;
  }

  // 显示所有结果（默认最多10个，由 limit 参数控制）
  const displayCount = results.length;
  let text = `找到 ${results.length} 个附近的${keyword}：\n\n`;

  results.forEach((poi, index) => {
    const distanceText = poi.distance < 1000
      ? `${poi.distance}米`
      : `${(poi.distance / 1000).toFixed(1)}公里`;

    text += `${index + 1}. **${poi.name}**\n`;
    text += `   📍 ${poi.address}\n`;
    text += `   🚶 距离：${distanceText}\n`;
    if (poi.phone !== '暂无') {
      text += `   📞 ${poi.phone}\n`;
    }
    text += '\n';
  });

  return text.trim();
}

/**
 * 格式化错误
 */
function formatError(code, message) {
  return {
    success: false,
    error: code,
    message: message
  };
}

// 如果直接运行（测试用）
if (import.meta.url === `file://${process.argv[1]}`) {
  const testInput = {
    address: "北京市朝阳区望京北路1号中国数码港大厦",
    keyword: "理发店",
    radius: 1000
  };
  
  run(testInput).then(result => {
    console.log(JSON.stringify(result, null, 2));
  });
}
