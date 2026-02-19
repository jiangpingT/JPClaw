/**
 * 中央配置管理器
 * 支持热重载、环境变量、文件监听和配置验证
 */

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { log, logError } from "./logger.js";
import { JPClawError, ErrorCode } from "./errors.js";
import { metrics } from "../monitoring/metrics.js";

// 配置源类型
export type ConfigSource = "file" | "env" | "override" | "default";

// 配置项定义
export interface ConfigSchema {
  [key: string]: {
    type: "string" | "number" | "boolean" | "object" | "array";
    default?: any;
    required?: boolean;
    validator?: (value: any) => boolean;
    description?: string;
    sensitive?: boolean; // 敏感信息，不记录到日志
  };
}

// 配置值包装器
export interface ConfigValue<T = any> {
  value: T;
  source: ConfigSource;
  timestamp: number;
  path: string[];
}

// 配置变更事件
export interface ConfigChangeEvent {
  path: string[];
  oldValue: any;
  newValue: any;
  source: ConfigSource;
  timestamp: number;
}

// 配置监听器
export interface ConfigWatcher {
  path: string[];
  callback: (change: ConfigChangeEvent) => void;
  once?: boolean;
}

/**
 * 动态配置管理器
 */
export class DynamicConfigManager extends EventEmitter {
  private config = new Map<string, ConfigValue>();
  private schema: ConfigSchema = {};
  private watchers: ConfigWatcher[] = [];
  private fileWatchers = new Map<string, fs.FSWatcher>();
  private loadedFiles = new Set<string>();

  constructor() {
    super();
    this.setupProcessEnvWatcher();
  }

  /**
   * 定义配置结构
   */
  defineSchema(schema: ConfigSchema): void {
    this.schema = { ...this.schema, ...schema };
    
    // 验证现有配置
    this.validateAllConfigs();
  }

  /**
   * 从文件加载配置
   */
  async loadFromFile(filePath: string, watchChanges = true): Promise<void> {
    try {
      const absolutePath = path.resolve(filePath);
      
      if (!fs.existsSync(absolutePath)) {
        log("warn", "Configuration file not found", { path: absolutePath });
        return;
      }

      const content = fs.readFileSync(absolutePath, 'utf-8');
      let data: any;

      // 根据文件扩展名解析
      const ext = path.extname(absolutePath).toLowerCase();
      switch (ext) {
        case '.json':
          data = JSON.parse(content);
          break;
        case '.js':
        case '.ts':
          // 动态导入
          const modulePath = `file://${absolutePath}`;
          const module = await import(modulePath);
          data = module.default || module;
          break;
        default:
          throw new JPClawError({
            code: ErrorCode.INPUT_VALIDATION_FAILED,
            message: `Unsupported config file format: ${ext}`
          });
      }

      this.setConfigFromObject(data, "file", []);
      this.loadedFiles.add(absolutePath);

      if (watchChanges) {
        this.watchFile(absolutePath);
      }

      log("info", "Configuration loaded from file", {
        path: absolutePath,
        keys: Object.keys(data).length
      });

      this.emit('file-loaded', { path: absolutePath, data });

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.SYSTEM_INTERNAL,
        message: `Failed to load config file: ${filePath}`,
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 从环境变量加载配置
   */
  loadFromEnv(prefix = "JPCLAW_"): void {
    const envVars = Object.entries(process.env).filter(([key]) => 
      key.startsWith(prefix)
    );

    for (const [envKey, envValue] of envVars) {
      if (envValue === undefined) continue;

      // 将环境变量键转换为配置路径
      const configKey = envKey.slice(prefix.length).toLowerCase();
      const path = configKey.split('_');

      // 尝试类型转换
      const typedValue = this.parseEnvValue(envValue, path);
      
      this.setConfig(path, typedValue, "env");
    }

    log("info", "Configuration loaded from environment", {
      prefix,
      count: envVars.length
    });
  }

  /**
   * 设置配置值
   */
  setConfig(path: string | string[], value: any, source: ConfigSource = "override"): void {
    const pathArray = Array.isArray(path) ? path : path.split('.');
    const pathKey = pathArray.join('.');
    
    // 验证配置值
    if (!this.validateConfig(pathArray, value)) {
      throw new JPClawError({
        code: ErrorCode.INPUT_VALIDATION_FAILED,
        message: `Invalid configuration value for ${pathKey}`
      });
    }

    const oldValue = this.config.get(pathKey);
    const newConfigValue: ConfigValue = {
      value,
      source,
      timestamp: Date.now(),
      path: pathArray
    };

    this.config.set(pathKey, newConfigValue);

    // 触发变更事件
    const changeEvent: ConfigChangeEvent = {
      path: pathArray,
      oldValue: oldValue?.value,
      newValue: value,
      source,
      timestamp: newConfigValue.timestamp
    };

    this.notifyWatchers(changeEvent);
    this.emit('config-changed', changeEvent);

    metrics.increment("config.changed", 1, {
      path: pathKey,
      source
    });
  }

  /**
   * 获取配置值
   */
  getConfig<T = any>(path: string | string[], defaultValue?: T): T {
    const pathArray = Array.isArray(path) ? path : path.split('.');
    const pathKey = pathArray.join('.');
    
    const configValue = this.config.get(pathKey);
    if (configValue) {
      return configValue.value as T;
    }

    // 检查schema中的默认值
    const schemaEntry = this.schema[pathKey];
    if (schemaEntry && schemaEntry.default !== undefined) {
      return schemaEntry.default as T;
    }

    if (defaultValue !== undefined) {
      return defaultValue;
    }

    // 检查是否为必需配置
    if (schemaEntry?.required) {
      throw new JPClawError({
        code: ErrorCode.INPUT_VALIDATION_FAILED,
        message: `Required configuration missing: ${pathKey}`
      });
    }

    return undefined as any;
  }

  /**
   * 检查配置是否存在
   */
  hasConfig(path: string | string[]): boolean {
    const pathArray = Array.isArray(path) ? path : path.split('.');
    const pathKey = pathArray.join('.');
    return this.config.has(pathKey);
  }

  /**
   * 删除配置
   */
  deleteConfig(path: string | string[]): boolean {
    const pathArray = Array.isArray(path) ? path : path.split('.');
    const pathKey = pathArray.join('.');
    
    const existed = this.config.has(pathKey);
    if (existed) {
      const oldValue = this.config.get(pathKey)?.value;
      this.config.delete(pathKey);

      const changeEvent: ConfigChangeEvent = {
        path: pathArray,
        oldValue,
        newValue: undefined,
        source: "override",
        timestamp: Date.now()
      };

      this.notifyWatchers(changeEvent);
      this.emit('config-changed', changeEvent);
    }

    return existed;
  }

  /**
   * 监听配置变更
   */
  watch(path: string | string[], callback: (change: ConfigChangeEvent) => void, once = false): () => void {
    const pathArray = Array.isArray(path) ? path : path.split('.');
    
    const watcher: ConfigWatcher = {
      path: pathArray,
      callback,
      once
    };

    this.watchers.push(watcher);

    // 返回取消监听的函数
    return () => {
      const index = this.watchers.indexOf(watcher);
      if (index !== -1) {
        this.watchers.splice(index, 1);
      }
    };
  }

  /**
   * 获取所有配置
   */
  getAllConfigs(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    
    for (const [key, configValue] of this.config) {
      // 过滤敏感信息
      const schemaEntry = this.schema[key];
      if (schemaEntry?.sensitive) {
        result[key] = "[SENSITIVE]";
      } else {
        result[key] = configValue.value;
      }
    }

    return result;
  }

  /**
   * 获取配置统计信息
   */
  getStats(): {
    totalConfigs: number;
    bySource: Record<ConfigSource, number>;
    fileWatchers: number;
    configWatchers: number;
  } {
    const bySource: Record<ConfigSource, number> = {
      file: 0,
      env: 0,
      override: 0,
      default: 0
    };

    for (const configValue of this.config.values()) {
      bySource[configValue.source]++;
    }

    return {
      totalConfigs: this.config.size,
      bySource,
      fileWatchers: this.fileWatchers.size,
      configWatchers: this.watchers.length
    };
  }

  /**
   * 导出配置到文件
   */
  async exportToFile(filePath: string, includeDefaults = false): Promise<void> {
    try {
      const config = includeDefaults ? this.getAllConfigsWithDefaults() : this.getAllConfigs();
      const content = JSON.stringify(config, null, 2);
      
      await fs.promises.writeFile(filePath, content);
      
      log("info", "Configuration exported to file", {
        path: filePath,
        keys: Object.keys(config).length
      });

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.SYSTEM_INTERNAL,
        message: `Failed to export config to file: ${filePath}`,
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 重新加载所有文件
   */
  async reloadFiles(): Promise<void> {
    const promises = Array.from(this.loadedFiles).map(filePath => 
      this.loadFromFile(filePath, false)
    );

    await Promise.allSettled(promises);
    
    log("info", "Configuration files reloaded", {
      count: this.loadedFiles.size
    });
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    // 停止文件监听
    for (const watcher of this.fileWatchers.values()) {
      watcher.close();
    }
    this.fileWatchers.clear();

    // 清理监听器
    this.watchers.length = 0;
    this.removeAllListeners();

    log("info", "Configuration manager cleaned up");
  }

  private setConfigFromObject(obj: any, source: ConfigSource, basePath: string[]): void {
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = [...basePath, key];
      
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        this.setConfigFromObject(value, source, currentPath);
      } else {
        this.setConfig(currentPath, value, source);
      }
    }
  }

  private parseEnvValue(value: string, path: string[]): any {
    const pathKey = path.join('.');
    const schemaEntry = this.schema[pathKey];
    
    if (!schemaEntry) {
      return value; // 返回原始字符串
    }

    switch (schemaEntry.type) {
      case 'boolean':
        return value.toLowerCase() === 'true';
      case 'number':
        const num = Number(value);
        return isNaN(num) ? value : num;
      case 'array':
        try {
          return JSON.parse(value);
        } catch {
          return value.split(',').map(s => s.trim());
        }
      case 'object':
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      default:
        return value;
    }
  }

  private validateConfig(path: string[], value: any): boolean {
    const pathKey = path.join('.');
    const schemaEntry = this.schema[pathKey];
    
    if (!schemaEntry) {
      return true; // 没有schema定义，允许任何值
    }

    // 类型检查
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (schemaEntry.type !== actualType && value !== null && value !== undefined) {
      log("warn", "Configuration type mismatch", {
        path: pathKey,
        expected: schemaEntry.type,
        actual: actualType,
        value
      });
      return false;
    }

    // 自定义验证器
    if (schemaEntry.validator && !schemaEntry.validator(value)) {
      log("warn", "Configuration validation failed", {
        path: pathKey,
        value
      });
      return false;
    }

    return true;
  }

  private validateAllConfigs(): void {
    for (const [pathKey, configValue] of this.config) {
      const path = pathKey.split('.');
      if (!this.validateConfig(path, configValue.value)) {
        log("warn", "Existing configuration failed validation", {
          path: pathKey,
          value: configValue.value
        });
      }
    }
  }

  private watchFile(filePath: string): void {
    if (this.fileWatchers.has(filePath)) {
      return; // 已经在监听
    }

    try {
      const watcher = fs.watch(filePath, { persistent: false }, (eventType, filename) => {
        if (eventType === 'change') {
          log("info", "Configuration file changed", { path: filePath });
          
          // 延迟重载，避免频繁更新
          setTimeout(() => {
            this.loadFromFile(filePath, false).catch(error => {
              log("error", "Failed to reload config file", {
                path: filePath,
                error: String(error)
              });
            });
          }, 1000);
        }
      });

      this.fileWatchers.set(filePath, watcher);
      
    } catch (error) {
      log("warn", "Failed to watch config file", {
        path: filePath,
        error: String(error)
      });
    }
  }

  private notifyWatchers(change: ConfigChangeEvent): void {
    const toRemove: ConfigWatcher[] = [];
    
    for (const watcher of this.watchers) {
      // 检查路径是否匹配
      if (this.pathMatches(watcher.path, change.path)) {
        try {
          watcher.callback(change);
          
          if (watcher.once) {
            toRemove.push(watcher);
          }
        } catch (error) {
          log("error", "Configuration watcher error", {
            path: change.path.join('.'),
            error: String(error)
          });
        }
      }
    }

    // 移除一次性监听器
    for (const watcher of toRemove) {
      const index = this.watchers.indexOf(watcher);
      if (index !== -1) {
        this.watchers.splice(index, 1);
      }
    }
  }

  private pathMatches(watcherPath: string[], changePath: string[]): boolean {
    // 精确匹配
    if (watcherPath.length === changePath.length) {
      return watcherPath.every((segment, index) => segment === changePath[index]);
    }
    
    // 前缀匹配 (监听父路径)
    if (watcherPath.length < changePath.length) {
      return watcherPath.every((segment, index) => segment === changePath[index]);
    }
    
    return false;
  }

  private getAllConfigsWithDefaults(): Record<string, unknown> {
    const result = this.getAllConfigs();
    
    // 添加schema中定义的默认值
    for (const [key, schemaEntry] of Object.entries(this.schema)) {
      if (!result.hasOwnProperty(key) && schemaEntry.default !== undefined) {
        result[key] = schemaEntry.default;
      }
    }

    return result;
  }

  private setupProcessEnvWatcher(): void {
    // 在Node.js中，无法直接监听环境变量变化
    // 这里可以提供手动刷新环境变量的方法
  }
}

/**
 * 全局配置管理器实例
 */
export class GlobalConfigManager extends DynamicConfigManager {
  private static instance: GlobalConfigManager;

  static getInstance(): GlobalConfigManager {
    if (!GlobalConfigManager.instance) {
      GlobalConfigManager.instance = new GlobalConfigManager();
      GlobalConfigManager.instance.setupDefaultSchema();
    }
    return GlobalConfigManager.instance;
  }

  private setupDefaultSchema(): void {
    // 定义JPClaw的配置结构
    this.defineSchema({
      'gateway.port': {
        type: 'number',
        default: 8080,
        description: 'Gateway server port'
      },
      'gateway.host': {
        type: 'string',
        default: '0.0.0.0',
        description: 'Gateway server host'
      },
      'memory.vector.enabled': {
        type: 'boolean',
        default: true,
        description: 'Enable vector memory system'
      },
      'memory.cleanup.interval': {
        type: 'number',
        default: 3600000, // 1 hour
        description: 'Memory cleanup interval in ms'
      },
      'discord.enabled': {
        type: 'boolean',
        default: false,
        description: 'Enable Discord channel'
      },
      'discord.token': {
        type: 'string',
        required: true,
        sensitive: true,
        description: 'Discord bot token'
      },
      'providers.anthropic.apiKey': {
        type: 'string',
        required: true,
        sensitive: true,
        description: 'Anthropic API key'
      },
      'security.rateLimit.enabled': {
        type: 'boolean',
        default: true,
        description: 'Enable rate limiting'
      },
      'monitoring.metrics.enabled': {
        type: 'boolean',
        default: true,
        description: 'Enable metrics collection'
      }
    });
  }
}

// 导出全局实例
export const globalConfig = GlobalConfigManager.getInstance();

// 便捷函数
export function getConfig<T = any>(path: string, defaultValue?: T): T {
  return globalConfig.getConfig(path, defaultValue);
}

export function setConfig(path: string, value: any): void {
  globalConfig.setConfig(path, value);
}

export function watchConfig(
  path: string, 
  callback: (change: ConfigChangeEvent) => void
): () => void {
  return globalConfig.watch(path, callback);
}