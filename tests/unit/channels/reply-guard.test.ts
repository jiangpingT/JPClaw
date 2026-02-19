/**
 * 回复防护测试
 * 迁移自 tests/js/reply-guard.spec.ts → Vitest 统一框架
 */
import { describe, it, expect } from 'vitest';
import { classifyOffTargetReply } from "../../../src/js/channels/reply-guard.js";

describe('classifyOffTargetReply', () => {
  it('should detect directory listing drift for non-local questions', () => {
    const raw = "你的哪个 skill 对我最有用";
    const output = [
      "目录：/Users/mlamp/Downloads",
      "总计：文件 7，文件夹 7",
      "最近变更：",
      "[F] a.pdf",
      "[D] docs",
      "[F] b.docx"
    ].join("\n");
    expect(classifyOffTargetReply(raw, output)).toBe("directory_listing");
  });

  it('should not flag directory listing for local file operation requests', () => {
    const raw = "帮我查看下载目录";
    const output = [
      "目录：/Users/mlamp/Downloads",
      "总计：文件 7，文件夹 7",
      "最近变更：",
      "[F] a.pdf",
      "[D] docs"
    ].join("\n");
    expect(classifyOffTargetReply(raw, output)).toBeNull();
  });

  it('should detect social stats drift for biography request', () => {
    const raw = "请你介绍一下明略科技的姜平";
    const output = [
      "主页数据（2/13/2026, 4:54:24 PM）",
      "被关注/粉丝：717",
      "关注：314"
    ].join("\n");
    expect(classifyOffTargetReply(raw, output)).toBe("social_stats");
  });

  it('should detect generic presence ack drift', () => {
    const raw = "你的哪个 skill 对我最有用";
    const output = "我在，随时可以开始。";
    expect(classifyOffTargetReply(raw, output)).toBe("presence_ack");
  });

  it('should detect weather drift for non-weather requests', () => {
    const raw = "帮我收集所有关于 OpenAI 的最新信息";
    const output = [
      "天气检索（天津）",
      "当前: Haze, 4°C, 体感 3°C",
      "湿度: 75% | 风速: 6 km/h"
    ].join("\n");
    expect(classifyOffTargetReply(raw, output)).toBe("weather_report");
  });

  it('should detect auto-skill template drift for normal QA requests', () => {
    const raw = "请你介绍一下明略科技的姜平";
    const output = [
      "检测到可复用任务，已自动生成技能模板：skills/auto-skill-1-2/",
      "请告诉我需要的输入/输出与执行步骤，我会完善技能并运行。"
    ].join("\n");
    expect(classifyOffTargetReply(raw, output)).toBe("auto_skill_template");
  });
});
