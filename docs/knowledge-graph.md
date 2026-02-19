# JPClaw 知识图谱

## 概述

JPClaw 知识图谱是一个轻量级的图数据库实现，用于从用户对话和记忆中自动提取实体和关系，构建结构化的知识网络。它与现有的向量化检索和传统记忆系统无缝集成，提供强大的关系查询和图遍历能力。

### 为什么需要知识图谱？

- **结构化知识存储**: 将碎片化的记忆转化为结构化的实体-关系网络
- **复杂关系查询**: 回答如"张三在哪家公司工作？"、"我认识哪些会Python的人？"这样的关系型问题
- **知识推理**: 通过路径查询发现隐藏的关联关系
- **实体消歧**: 自动合并重复提到的相同实体，保持知识一致性

### 核心特性

- ✅ **轻量级架构**: 使用SQLite持久化，无需额外服务
- ✅ **自动提取**: 从自然语言文本中自动提取实体和关系
- ✅ **快速查询**: 内存图索引提供O(1)邻居查询和快速BFS路径查找
- ✅ **双层提取**: 规则匹配 + 可选LLM增强，平衡速度和准确性
- ✅ **实体消歧**: 自动识别和合并重复实体
- ✅ **无缝集成**: 与EnhancedMemoryManager深度集成，开箱即用

---

## 快速开始

### 基础用法

```javascript
import { knowledgeGraph } from "./dist/memory/knowledge-graph.js";

// 1. 初始化知识图谱
await knowledgeGraph.initialize(userId);

// 2. 从文本提取实体和关系
const result = await knowledgeGraph.extractFromMemory(
  "我叫张三，在明略科技工作，擅长Python编程",
  userId,
  memoryId,
  {
    useLLM: false,       // 是否使用LLM增强（默认false）
    autoMerge: true      // 自动合并重复实体（默认true）
  }
);

console.log(`提取了 ${result.entities.length} 个实体`);
console.log(`提取了 ${result.relations.length} 个关系`);

// 3. 查询实体
const persons = await knowledgeGraph.queryEntities({
  userId,
  type: "PERSON",
  limit: 10
});

// 4. 图遍历 - 获取邻居
const neighbors = await knowledgeGraph.getNeighbors(entityId);
console.log(`邻居: ${neighbors.entities.map(e => e.name).join(", ")}`);

// 5. 路径查询
const paths = await knowledgeGraph.findPaths(sourceId, targetId, 3);
if (paths.length > 0) {
  const path = paths[0];
  console.log(`路径: ${path.entities.map(e => e.name).join(" → ")}`);
}

// 6. 子图提取
const subgraph = await knowledgeGraph.extractSubgraph(centerEntityId, 2);
console.log(`子图包含 ${subgraph.entities.length} 个实体`);

// 7. 统计信息
const stats = await knowledgeGraph.getStatistics(userId);
console.log(`总计: ${stats.entityCount} 个实体, ${stats.relationCount} 个关系`);
```

### 与EnhancedMemoryManager集成

```javascript
import { enhancedMemoryManager } from "./dist/memory/enhanced-memory-manager.js";

// 更新记忆时自动提取图谱（默认开启）
const result = await enhancedMemoryManager.updateMemory(
  userId,
  "李四是我的同事，他会Java开发",
  {
    extractGraph: true,      // 默认true，是否提取图谱
    useLLMForGraph: false    // 默认false，是否使用LLM增强
  }
);

if (result.graphExtracted) {
  console.log(`自动提取了 ${result.graphExtracted.entities.length} 个实体`);
}

// 查询时包含图谱结果
const queryResult = await enhancedMemoryManager.query({
  text: "Python",
  userId,
  options: {
    useSemanticSearch: true,
    useGraphQuery: true,        // 启用图谱查询
    graphQueryType: "entity"    // 查询类型: entity | relation | path | subgraph
  }
});

if (queryResult.graphResults) {
  console.log(`图谱找到 ${queryResult.graphResults.entities.length} 个实体`);
}
```

---

## 实体类型和关系类型

### 支持的实体类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `PERSON` | 人物 | 张三、李明、我 |
| `ORGANIZATION` | 组织 | 明略科技、腾讯、北京大学 |
| `LOCATION` | 地点 | 北京、深圳、中关村 |
| `EVENT` | 事件 | 项目启动会议、年会、发布会 |
| `CONCEPT` | 概念 | 机器学习、推荐系统、分布式 |
| `PRODUCT` | 产品 | iPhone、ChatGPT、JPClaw |
| `TIME` | 时间 | 2024年、下周、今天 |
| `SKILL` | 技能 | Python编程、架构设计、Java开发 |
| `PREFERENCE` | 偏好 | 喜欢编程、不喜欢加班 |

### 支持的关系类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `WORKS_AT` | 工作于 | 张三 WORKS_AT 腾讯 |
| `LOCATED_IN` | 位于 | 腾讯 LOCATED_IN 深圳 |
| `KNOWS` | 认识 | 张三 KNOWS 李四 |
| `LIKES` | 喜欢 | 张三 LIKES 编程 |
| `DISLIKES` | 不喜欢 | 张三 DISLIKES 加班 |
| `HAS_SKILL` | 拥有技能 | 张三 HAS_SKILL Python |
| `PARTICIPATED_IN` | 参与 | 张三 PARTICIPATED_IN 项目 |
| `RELATED_TO` | 相关 | 机器学习 RELATED_TO 推荐系统 |
| `OWNS` | 拥有 | 张三 OWNS iPhone |
| `HAPPENED_AT` | 发生于 | 会议 HAPPENED_AT 下周 |

---

## API 文档

### KnowledgeGraph 类

#### initialize(userId?: string): Promise<void>

初始化知识图谱，创建数据库表和索引。

```javascript
await knowledgeGraph.initialize(userId);
```

#### extractFromMemory(text, userId, memoryId, options): Promise<GraphExtractionResult>

从文本中提取实体和关系。

**参数:**
- `text` (string): 要提取的文本
- `userId` (string): 用户ID
- `memoryId` (string): 记忆ID（用于关联）
- `options` (GraphExtractionOptions):
  - `useLLM` (boolean): 是否使用LLM增强，默认false
  - `autoMerge` (boolean): 自动合并重复实体，默认true
  - `entityThreshold` (number): 实体置信度阈值，默认0.5
  - `relationThreshold` (number): 关系置信度阈值，默认0.5

**返回:** `{ entities: GraphEntity[], relations: GraphRelation[] }`

```javascript
const result = await knowledgeGraph.extractFromMemory(
  "我叫张三，在明略科技工作",
  userId,
  memoryId,
  { useLLM: false, autoMerge: true }
);
```

#### queryEntities(filter): Promise<GraphEntity[]>

查询实体。

**参数:**
- `filter` (EntityQueryFilter):
  - `userId` (string): 用户ID（必需）
  - `name` (string): 实体名称（可选，模糊匹配）
  - `type` (EntityType): 实体类型（可选）
  - `minConfidence` (number): 最小置信度（可选）
  - `minImportance` (number): 最小重要性（可选）
  - `limit` (number): 结果数量限制（可选）

```javascript
// 查询所有人物实体
const persons = await knowledgeGraph.queryEntities({
  userId,
  type: "PERSON",
  limit: 10
});

// 按名称查询
const entities = await knowledgeGraph.queryEntities({
  userId,
  name: "张三"
});
```

#### queryRelations(filter): Promise<GraphRelation[]>

查询关系。

**参数:**
- `filter` (RelationQueryFilter):
  - `userId` (string): 用户ID（必需）
  - `sourceId` (string): 源实体ID（可选）
  - `targetId` (string): 目标实体ID（可选）
  - `type` (RelationType): 关系类型（可选）
  - `minConfidence` (number): 最小置信度（可选）
  - `limit` (number): 结果数量限制（可选）

```javascript
// 查询某个实体的所有出边
const relations = await knowledgeGraph.queryRelations({
  userId,
  sourceId: entityId
});

// 查询特定类型的关系
const worksAtRelations = await knowledgeGraph.queryRelations({
  userId,
  type: "WORKS_AT"
});
```

#### getNeighbors(entityId, direction): Promise<NeighborQueryResult>

获取实体的邻居节点。

**参数:**
- `entityId` (string): 实体ID
- `direction` ("out" | "in" | "both"): 查询方向，默认"both"

**返回:** `{ entities: GraphEntity[], relations: GraphRelation[] }`

```javascript
// 获取所有邻居
const neighbors = await knowledgeGraph.getNeighbors(entityId);

// 只获取出边邻居
const outgoing = await knowledgeGraph.getNeighbors(entityId, "out");
```

#### findPaths(sourceId, targetId, maxDepth): Promise<GraphPath[]>

查找两个实体间的路径（BFS）。

**参数:**
- `sourceId` (string): 源实体ID
- `targetId` (string): 目标实体ID
- `maxDepth` (number): 最大路径长度（跳数），默认3

**返回:** 路径数组，按分数降序排列

```javascript
const paths = await knowledgeGraph.findPaths(sourceId, targetId, 3);
if (paths.length > 0) {
  const shortestPath = paths[0];
  console.log(`路径: ${shortestPath.entities.map(e => e.name).join(" → ")}`);
  console.log(`长度: ${shortestPath.distance}跳`);
  console.log(`分数: ${shortestPath.score}`);
}
```

#### extractSubgraph(centerEntityId, radius): Promise<SubgraphQueryResult>

提取以某个实体为中心的子图。

**参数:**
- `centerEntityId` (string): 中心实体ID
- `radius` (number): 子图半径（跳数），默认2

**返回:** `{ entities: GraphEntity[], relations: GraphRelation[], centerEntityId, radius }`

```javascript
const subgraph = await knowledgeGraph.extractSubgraph(entityId, 2);
console.log(`子图包含 ${subgraph.entities.length} 个实体`);
console.log(`子图包含 ${subgraph.relations.length} 个关系`);
```

#### mergeEntities(entityIds): Promise<string>

合并多个实体为一个实体。

**参数:**
- `entityIds` (string[]): 要合并的实体ID数组

**返回:** 合并后的主实体ID

```javascript
// 合并"张三"和"老张"为同一个实体
const mergedId = await knowledgeGraph.mergeEntities([entity1Id, entity2Id]);
```

#### getStatistics(userId): Promise<GraphStatistics>

获取图谱统计信息。

**返回:**
- `entityCount`: 实体总数
- `relationCount`: 关系总数
- `byEntityType`: 按实体类型统计
- `byRelationType`: 按关系类型统计

```javascript
const stats = await knowledgeGraph.getStatistics(userId);
console.log(`总计: ${stats.entityCount} 个实体, ${stats.relationCount} 个关系`);
console.log("按类型:", stats.byEntityType);
```

#### rebuildIndex(userId): Promise<void>

重建内存图索引（用于数据恢复或优化）。

```javascript
await knowledgeGraph.rebuildIndex(userId);
```

---

## 配置选项

### 环境变量

```bash
# 知识图谱数据库路径
JPCLAW_GRAPH_DB_PATH=sessions/memory/graph.sqlite

# 是否启用知识图谱（默认true）
JPCLAW_KNOWLEDGE_GRAPH_ENABLED=true

# 实体提取选项
JPCLAW_GRAPH_USE_LLM=false              # 是否使用LLM增强提取
JPCLAW_GRAPH_ENTITY_THRESHOLD=0.5       # 实体置信度阈值
JPCLAW_GRAPH_RELATION_THRESHOLD=0.5     # 关系置信度阈值

# 图索引配置
JPCLAW_GRAPH_INDEX_REBUILD_INTERVAL=3600000  # 重建索引间隔（1小时）
JPCLAW_GRAPH_PATH_CACHE_SIZE=1000            # 路径缓存大小
```

---

## 性能和最佳实践

### 性能特点

- **实体提取**: 规则匹配 < 10ms，LLM增强 1-3秒
- **邻居查询**: O(1) 复杂度，< 1ms
- **路径查询**: BFS算法，3跳路径 < 100ms
- **子图提取**: 2跳子图 < 50ms
- **数据加载**: 1000实体 + 2000关系 约200ms

### 最佳实践

1. **使用规则提取优先**
   - 规则提取速度快、确定性高
   - 仅在需要高准确性时启用LLM增强

2. **合理设置置信度阈值**
   - 默认0.5适用于大多数场景
   - 提高阈值可减少噪音，但可能丢失信息

3. **定期重建索引**
   - 大量数据更新后重建索引以优化性能
   - 建议每小时或每天重建一次

4. **利用缓存**
   - 路径查询结果会被缓存
   - 重复查询可获得极高性能

5. **控制查询范围**
   - 路径查询不要超过4跳（复杂度指数增长）
   - 子图提取建议半径 ≤ 3

6. **实体消歧**
   - 启用autoMerge自动合并重复实体
   - 手动使用mergeEntities处理复杂情况

---

## 故障排查

### 常见问题

**Q: 实体提取为空？**

A: 检查文本内容是否匹配预定义模式，或启用LLM增强提取。

```javascript
// 查看当前模式
import { entityExtractor } from "./dist/memory/entity-extractor.js";
const patterns = entityExtractor.getPatterns();
console.log(patterns.map(p => p.pattern.source));

// 添加自定义模式
entityExtractor.addPattern({
  pattern: /自定义模式/g,
  type: "PERSON",
  confidence: 0.9,
  extractName: (match) => match[1]
});
```

**Q: 路径查询找不到路径？**

A: 检查实体间是否真的存在连接关系，或增加maxDepth参数。

```javascript
// 检查两个实体的邻居
const neighbors1 = await knowledgeGraph.getNeighbors(entity1Id);
const neighbors2 = await knowledgeGraph.getNeighbors(entity2Id);
console.log("Entity1 neighbors:", neighbors1.entities.map(e => e.name));
console.log("Entity2 neighbors:", neighbors2.entities.map(e => e.name));

// 增加搜索深度
const paths = await knowledgeGraph.findPaths(entity1Id, entity2Id, 5);
```

**Q: 性能下降？**

A: 重建索引或清理低质量数据。

```javascript
// 重建索引
await knowledgeGraph.rebuildIndex(userId);

// 删除低置信度实体
const entities = await knowledgeGraph.queryEntities({ userId });
for (const entity of entities) {
  if (entity.confidence < 0.3) {
    await knowledgeGraph.deleteEntity(entity.id);
  }
}
```

**Q: SQLite数据库锁定错误？**

A: 这通常是并发写入导致的。解决方法：

```javascript
// 方法1: 使用队列顺序化写入（已内置）
// 方法2: 检查WAL模式是否启用
// 方法3: 增加超时时间（在graph-store.ts中配置）
```

---

## 与其他系统集成

### 与向量化记忆集成

知识图谱自动与向量化记忆关联：

```javascript
// 向量化记忆和图谱共享同一个memoryId
const result = await enhancedMemoryManager.updateMemory(userId, text);
const memoryId = result.vectorsAdded[0];

// 通过memoryId可以找到对应的实体和关系
const entities = await knowledgeGraph.queryEntities({ userId });
const relatedEntities = entities.filter(e => e.source.memoryId === memoryId);
```

### 与冲突解决集成

知识图谱可以辅助冲突解决：

```javascript
// 检测实体级冲突
const entities = await knowledgeGraph.queryEntities({
  userId,
  name: "张三"
});

if (entities.length > 1) {
  // 发现重复实体，可能存在冲突
  const conflictingEntities = entities.filter(e => {
    // 检查属性冲突
    return e.properties.age !== entities[0].properties.age;
  });

  if (conflictingEntities.length > 0) {
    // 合并或标记冲突
    await knowledgeGraph.mergeEntities(entities.map(e => e.id));
  }
}
```

### 导出和导入

```javascript
// 导出图谱数据
const entities = await knowledgeGraph.queryEntities({ userId });
const relations = await knowledgeGraph.queryRelations({ userId });
const graphData = { entities, relations };
await fs.writeFile("graph-export.json", JSON.stringify(graphData, null, 2));

// 导入图谱数据
const imported = JSON.parse(await fs.readFile("graph-export.json", "utf-8"));
for (const entity of imported.entities) {
  await graphStore.addEntity(entity);
}
for (const relation of imported.relations) {
  await graphStore.addRelation(relation);
}
await knowledgeGraph.rebuildIndex(userId);
```

---

## 扩展和自定义

### 添加自定义实体类型

修改 `knowledge-graph-types.ts`:

```typescript
export type EntityType =
  | "PERSON"
  | "ORGANIZATION"
  | ... 现有类型 ...
  | "CUSTOM_TYPE";  // 添加自定义类型
```

### 添加自定义关系类型

修改 `knowledge-graph-types.ts`:

```typescript
export type RelationType =
  | "WORKS_AT"
  | ... 现有类型 ...
  | "CUSTOM_RELATION";  // 添加自定义关系
```

### 添加自定义提取模式

```javascript
import { entityExtractor } from "./dist/memory/entity-extractor.js";
import { relationExtractor } from "./dist/memory/relation-extractor.js";

// 添加实体提取模式
entityExtractor.addPattern({
  pattern: /我的宠物叫(.+)/g,
  type: "CUSTOM_PET",
  confidence: 0.95,
  extractName: (match) => match[1].trim()
});

// 添加关系提取模式
relationExtractor.addPattern({
  pattern: /(.+?)养了(.+)/g,
  type: "OWNS_PET",
  confidence: 0.9,
  extractSource: (match) => match[1].trim(),
  extractTarget: (match) => match[2].trim()
});
```

---

## 后续优化方向

1. **实体链接** - 使用embedding相似度进行更智能的实体消歧
2. **关系验证** - 使用LLM验证提取的关系准确性
3. **时序图谱** - 支持关系的时间维度查询和演化分析
4. **图推理** - 基于已知关系推理新关系（传递性、对称性等）
5. **可视化** - 提供图谱可视化界面（集成D3.js、vis.js等）
6. **图压缩** - 自动合并冗余实体和关系，优化存储
7. **多模态图谱** - 支持图片、音频等多模态实体

---

## 测试

运行知识图谱测试脚本：

```bash
npm run build
node test-knowledge-graph.js
```

测试覆盖：
- ✅ 初始化和统计
- ✅ 实体和关系提取
- ✅ 图查询（按类型、按名称）
- ✅ 图遍历（邻居查询）
- ✅ 路径查询（BFS）
- ✅ 子图提取
- ✅ 与EnhancedMemoryManager集成

---

## 许可证

JPClaw知识图谱遵循 JPClaw 项目的许可证。

---

## 联系和支持

如有问题或建议，请通过以下方式联系：

- GitHub Issues: [JPClaw Issues](https://github.com/yourusername/jpclaw/issues)
- Email: support@jpclaw.com

---

**版本**: 1.0.0
**最后更新**: 2026-02-14
