export type OffTargetReason =
  | "directory_listing"
  | "social_stats"
  | "sync_report"
  | "presence_ack"
  | "weather_report"
  | "auto_skill_template";

export function classifyOffTargetReply(raw: string, output: string): OffTargetReason | null {
  const question = String(raw || "").trim();
  const answer = String(output || "").trim();
  if (!question || !answer) return null;

  // Skip off-target detection for capability/skill questions entirely
  if (looksLikeCapabilityQuestion(question)) {
    return null;
  }

  if (looksLikeDirectoryListingOutput(answer) && !looksLikeLocalRequest(question)) {
    return "directory_listing";
  }
  if (looksLikeSocialStatsOutput(answer) && !looksLikeSocialStatsRequest(question)) {
    return "social_stats";
  }
  if (looksLikeOpenClawSyncOutput(answer) && !looksLikeSyncAnalysisRequest(question)) {
    return "sync_report";
  }
  if (looksLikeWeatherOutput(answer) && !looksLikeWeatherRequest(question)) {
    return "weather_report";
  }
  if (looksLikeAutoSkillTemplateOutput(answer) && !looksLikeAutoSkillRequest(question)) {
    return "auto_skill_template";
  }
  return null;
}

function looksLikeLocalRequest(input: string): boolean {
  const q = input.toLowerCase();
  const hasPath = /~\/|\/users\/|\/downloads\/|\/desktop\/|\/documents\/|[a-z]:\\/.test(q);
  const hasLocalWord =
    /(目录|文件夹|文件|下载目录|downloads|download|本地|路径|打开应用|移动文件|删除文件|新建文件夹)/i.test(
      input
    );
  return hasPath || hasLocalWord;
}

function looksLikeSocialStatsRequest(input: string): boolean {
  const lower = input.toLowerCase();
  const hasUrl = /https?:\/\/\S+/.test(input);
  const hasSocialWord = /(关注|粉丝|点赞|评论|互动|被关注|主页)/.test(input);
  const hasPlatformHint =
    /(即刻|okjike\.com|微博|小红书|抖音|知乎|b站|bilibili)/i.test(lower);
  return (hasUrl && (hasSocialWord || hasPlatformHint)) || (hasPlatformHint && hasSocialWord);
}

function looksLikeSyncAnalysisRequest(input: string): boolean {
  return /(更新分析|代码变更|commit|仓库|分支|diff|版本差异|同步代码|openclaw\s*更新)/i.test(
    input
  );
}

function looksLikeCapabilityQuestion(input: string): boolean {
  return /(skill|技能|能力|会什么|能做什么|推荐|最有用|适合)/i.test(input);
}

function looksLikePresenceAck(output: string): boolean {
  return /^(我在|在的|在呢)[，,\s]*(随时可以开始|可以开始|你说|请说)/i.test(output);
}

function isSubstantiveAnswer(output: string): boolean {
  // 检查是否包含实质性内容（技能名称、具体建议等）
  const hasSkillMentions = /(skill|技能|coding|api|automation|数据|工具)/i.test(output);
  const hasSpecificContent = /(推荐|建议|适合|最好|可以用|试试|考虑)/i.test(output);
  const hasDetailedInfo = output.length > 50; // 简单的长度检查
  
  return hasSkillMentions || hasSpecificContent || hasDetailedInfo;
}

function looksLikeWeatherRequest(input: string): boolean {
  return /(天气|weather|温度|降雨|下雨|气温|风速|湿度|预报)/i.test(input);
}

function looksLikeWeatherOutput(output: string): boolean {
  return /(天气检索|天气\s*[（(].*[）)]|当前[:：].*\d+°C|湿度[:：].*%|风速[:：])/i.test(output);
}

function looksLikeAutoSkillRequest(input: string): boolean {
  return /(^\/skill\s+|创建技能|生成技能|写技能|封装成skill|封装技能)/i.test(input);
}

function looksLikeAutoSkillTemplateOutput(output: string): boolean {
  return /(检测到可复用任务.*自动生成技能模板|skills\/auto-[a-z0-9-_]+\/)/i.test(output);
}

function looksLikeSocialStatsOutput(output: string): boolean {
  return /主页数据\s*[（(].*[）)]/i.test(output) && /被关注\/粉丝[:：]/.test(output);
}

function looksLikeOpenClawSyncOutput(output: string): boolean {
  return /OpenClaw\s*更新分析/i.test(output) && /(仓库[:：].*github\.com|提交数[:：])/i.test(output);
}

export function looksLikeDirectoryListingOutput(text: string): boolean {
  const hasHeader = /目录：/.test(text) && /总计：文件\s*\d+/.test(text) && /最近变更：/.test(text);
  const fileItemCount = (text.match(/^\[(?:F|D)\]\s+/gm) || []).length;
  return hasHeader && fileItemCount >= 3;
}
