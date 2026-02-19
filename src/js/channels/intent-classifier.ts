function normalize(input: string): string {
  return String(input || "").trim().toLowerCase();
}

function includesAny(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

export function looksLikeCapabilityMetaQuestion(input: string): boolean {
  const q = normalize(input);
  if (!q) return false;

  const capabilityHints = [
    "skill",
    "技能",
    "能力",
    "会什么",
    "能做什么",
    "擅长",
    "功能",
    "可以做什么",
    "支持什么"
  ];
  const askHints = [
    "哪个",
    "哪些",
    "哪一个",
    "推荐",
    "最有用",
    "适合",
    "怎么用",
    "如何用",
    "有什么"
  ];
  const localOpHints = [
    "下载目录",
    "downloads",
    "download",
    "文件夹",
    "目录",
    "文件",
    "本地",
    "路径",
    "删除",
    "移动",
    "重命名",
    "创建",
    "新建",
    "打开应用"
  ];
  const hasPathLike = /~\/|\/users\/|\/downloads\/|\/desktop\/|\/documents\/|[a-z]:\\/.test(q);
  const hasCapability = includesAny(q, capabilityHints);
  const hasAsk = includesAny(q, askHints);
  const hasLocalOp = hasPathLike || includesAny(q, localOpHints);

  // Use intent signals instead of hard-coded exact phrase matching.
  return hasCapability && hasAsk && !hasLocalOp;
}

