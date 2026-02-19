/**
 * map-poi 技能测试
 * 运行：node skills/map-poi/test.js
 */

import { run } from './index.js';

// 测试用例
const testCases = [
  {
    name: '测试1：JSON格式输入 - 查找理发店',
    input: {
      address: "北京市朝阳区望京北路1号中国数码港大厦",
      keyword: "理发店",
      radius: 1000,
      limit: 5
    }
  },
  {
    name: '测试2：文本格式输入',
    input: "北京市朝阳区望京北路1号中国数码港大厦 附近的 咖啡店"
  },
  {
    name: '测试3：扩大搜索范围',
    input: {
      address: "北京市朝阳区望京北路1号",
      keyword: "川菜",
      radius: 2000,
      limit: 10
    }
  },
  {
    name: '测试4：无效地址（预期失败）',
    input: {
      address: "火星表面",
      keyword: "餐厅"
    }
  }
];

// 运行测试
async function runTests() {
  console.log('🧪 开始测试 map-poi 技能\n');
  console.log('='.repeat(60));
  
  // 检查API Key
  if (!process.env.AMAP_API_KEY) {
    console.log('⚠️  警告：未设置 AMAP_API_KEY 环境变量');
    console.log('请先运行：export AMAP_API_KEY="your_key_here"\n');
    console.log('申请地址：https://console.amap.com/dev/key/app\n');
    console.log('继续运行测试（部分测试将失败）...\n');
  }

  for (const testCase of testCases) {
    console.log(`\n📝 ${testCase.name}`);
    console.log('-'.repeat(60));
    console.log('输入：', JSON.stringify(testCase.input, null, 2));
    
    try {
      const startTime = Date.now();
      const result = await run(testCase.input);
      const duration = Date.now() - startTime;
      
      console.log('\n✅ 结果：');
      if (result.success) {
        console.log(`找到 ${result.total} 个结果（耗时 ${duration}ms）`);
        console.log('\n摘要：');
        console.log(result.summary);
      } else {
        console.log('❌ 错误：', result.error);
        console.log('详情：', result.message);
      }
      
    } catch (error) {
      console.log('❌ 异常：', error.message);
    }
    
    console.log('='.repeat(60));
  }
  
  console.log('\n✨ 测试完成！\n');
}

// 执行测试
runTests().catch(console.error);
