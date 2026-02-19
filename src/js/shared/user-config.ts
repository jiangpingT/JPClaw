// 用户配置管理 - 避免硬编码
export interface UserProfile {
  userId: string;
  displayName: string;
  nickname?: string;
  isOwner: boolean;
  preferredGreeting?: string;
}

export interface UserPreferences {
  defaultCity: string;
  language: string;
  responseStyle: string;
}

// 从环境变量和配置文件加载用户配置
export function getUserProfile(userId: string): UserProfile {
  const isOwner = isOwnerUser(userId);
  
  // 特定用户配置
  if (isOwner) {
    return {
      userId,
      displayName: "姜平",
      nickname: "姜哥",
      isOwner: true,
      preferredGreeting: "姜哥，"
    };
  }
  
  // 默认用户配置
  return {
    userId,
    displayName: "用户",
    isOwner: false,
    preferredGreeting: ""
  };
}

export function getUserPreferences(userId: string): UserPreferences {
  const isOwner = isOwnerUser(userId);
  
  return {
    defaultCity: process.env.JPCLAW_DEFAULT_CITY || (isOwner ? "天津" : "北京"),
    language: "zh-CN",
    responseStyle: isOwner ? "friendly" : "formal"
  };
}

export function getOwnerUserId(): string {
  return process.env.JPCLAW_OWNER_DISCORD_ID || "1351911386602672133";
}

export function isOwnerUser(userId: string): boolean {
  return userId === getOwnerUserId();
}