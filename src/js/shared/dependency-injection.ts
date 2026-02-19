/**
 * 依赖注入容器
 * 提供服务注册、解析和生命周期管理
 */

import { log, logError } from "./logger.js";
import { JPClawError, ErrorCode } from "./errors.js";
import { metrics } from "../monitoring/metrics.js";

// 服务生命周期
export type ServiceLifetime = "singleton" | "transient" | "scoped";

// 服务定义
export interface ServiceDefinition<T = any> {
  token: string;
  factory: (container: Container) => T | Promise<T>;
  lifetime: ServiceLifetime;
  dependencies?: string[];
  description?: string;
}

// 服务实例包装器
interface ServiceInstance<T = any> {
  value: T;
  created: number;
  accessed: number;
  accessCount: number;
}

// 服务统计
export interface ServiceStats {
  totalServices: number;
  singletons: number;
  transients: number;
  scoped: number;
  instances: number;
  accessCount: number;
  averageResolutionTime: number;
}

/**
 * 依赖注入容器
 */
export class Container {
  private services = new Map<string, ServiceDefinition>();
  private singletonInstances = new Map<string, ServiceInstance>();
  private scopedInstances = new Map<string, ServiceInstance>();
  private resolutionTimes: number[] = [];
  private creating = new Set<string>(); // 防止循环依赖

  constructor(private readonly name: string = "default") {}

  /**
   * 注册服务
   */
  register<T>(definition: ServiceDefinition<T>): void {
    if (this.services.has(definition.token)) {
      log("warn", "Service already registered, overriding", {
        token: definition.token,
        container: this.name
      });
    }

    this.services.set(definition.token, definition);
    
    log("debug", "Service registered", {
      token: definition.token,
      lifetime: definition.lifetime,
      container: this.name
    });

    metrics.increment("di.service.registered", 1, {
      container: this.name,
      lifetime: definition.lifetime
    });
  }

  /**
   * 注册单例服务
   */
  registerSingleton<T>(
    token: string,
    factory: (container: Container) => T | Promise<T>,
    dependencies?: string[]
  ): void {
    this.register({
      token,
      factory,
      lifetime: "singleton",
      dependencies
    });
  }

  /**
   * 注册瞬时服务
   */
  registerTransient<T>(
    token: string,
    factory: (container: Container) => T | Promise<T>,
    dependencies?: string[]
  ): void {
    this.register({
      token,
      factory,
      lifetime: "transient",
      dependencies
    });
  }

  /**
   * 注册作用域服务
   */
  registerScoped<T>(
    token: string,
    factory: (container: Container) => T | Promise<T>,
    dependencies?: string[]
  ): void {
    this.register({
      token,
      factory,
      lifetime: "scoped",
      dependencies
    });
  }

  /**
   * 注册实例
   */
  registerInstance<T>(token: string, instance: T): void {
    this.register({
      token,
      factory: () => instance,
      lifetime: "singleton"
    });

    // 直接缓存实例
    this.singletonInstances.set(token, {
      value: instance,
      created: Date.now(),
      accessed: Date.now(),
      accessCount: 0
    });
  }

  /**
   * 解析服务
   */
  async resolve<T>(token: string): Promise<T> {
    const startTime = Date.now();
    
    try {
      const service = await this.resolveInternal<T>(token);
      
      const resolutionTime = Date.now() - startTime;
      this.recordResolutionTime(resolutionTime);
      
      metrics.increment("di.service.resolved", 1, {
        container: this.name,
        token
      });

      return service;
    } catch (error) {
      metrics.increment("di.service.resolution_failed", 1, {
        container: this.name,
        token
      });
      throw error;
    }
  }

  /**
   * 尝试解析服务（不抛出异常）
   */
  async tryResolve<T>(token: string): Promise<T | null> {
    try {
      return await this.resolve<T>(token);
    } catch (error) {
      return null;
    }
  }

  /**
   * 检查服务是否已注册
   */
  isRegistered(token: string): boolean {
    return this.services.has(token);
  }

  /**
   * 获取所有已注册的服务标识
   */
  getRegisteredServices(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * 清理作用域实例
   */
  clearScope(): void {
    this.scopedInstances.clear();
    
    log("debug", "Scope cleared", {
      container: this.name
    });
  }

  /**
   * 创建子容器
   */
  createChildContainer(name: string = `${this.name}-child`): Container {
    const child = new Container(name);
    
    // 继承父容器的服务定义
    for (const [token, definition] of this.services) {
      child.services.set(token, definition);
    }

    return child;
  }

  /**
   * 验证依赖关系
   */
  validateDependencies(): {
    valid: boolean;
    issues: string[];
  } {
    const issues: string[] = [];
    
    for (const [token, definition] of this.services) {
      if (definition.dependencies) {
        for (const dependency of definition.dependencies) {
          if (!this.services.has(dependency)) {
            issues.push(`Service '${token}' depends on unregistered service '${dependency}'`);
          }
        }
      }
    }

    // 检查循环依赖
    const circularDeps = this.detectCircularDependencies();
    issues.push(...circularDeps);

    return {
      valid: issues.length === 0,
      issues
    };
  }

  /**
   * 获取容器统计信息
   */
  getStats(): ServiceStats {
    const lifetimeCounts = { singleton: 0, transient: 0, scoped: 0 };
    
    for (const definition of this.services.values()) {
      lifetimeCounts[definition.lifetime]++;
    }

    const totalAccessCount = Array.from(this.singletonInstances.values())
      .concat(Array.from(this.scopedInstances.values()))
      .reduce((sum, instance) => sum + instance.accessCount, 0);

    return {
      totalServices: this.services.size,
      singletons: lifetimeCounts.singleton,
      transients: lifetimeCounts.transient,
      scoped: lifetimeCounts.scoped,
      instances: this.singletonInstances.size + this.scopedInstances.size,
      accessCount: totalAccessCount,
      averageResolutionTime: this.calculateAverageResolutionTime()
    };
  }

  /**
   * 获取服务依赖图
   */
  getDependencyGraph(): Record<string, string[]> {
    const graph: Record<string, string[]> = {};
    
    for (const [token, definition] of this.services) {
      graph[token] = definition.dependencies || [];
    }

    return graph;
  }

  /**
   * 关闭容器并清理资源
   */
  dispose(): void {
    // 调用所有实例的 dispose 方法（如果有）
    const allInstances = [
      ...this.singletonInstances.values(),
      ...this.scopedInstances.values()
    ];

    for (const instance of allInstances) {
      if (instance.value && typeof instance.value.dispose === 'function') {
        try {
          instance.value.dispose();
        } catch (error) {
          log("error", "Error disposing service instance", {
            error: String(error),
            container: this.name
          });
        }
      }
    }

    this.services.clear();
    this.singletonInstances.clear();
    this.scopedInstances.clear();
    this.creating.clear();

    log("info", "Container disposed", {
      container: this.name
    });
  }

  private async resolveInternal<T>(token: string): Promise<T> {
    // 检查循环依赖
    if (this.creating.has(token)) {
      throw new JPClawError({
        code: ErrorCode.SYSTEM_INTERNAL,
        message: `Circular dependency detected while resolving '${token}'`
      });
    }

    const definition = this.services.get(token);
    if (!definition) {
      throw new JPClawError({
        code: ErrorCode.SYSTEM_INTERNAL,
        message: `Service '${token}' is not registered`
      });
    }

    // 根据生命周期处理
    switch (definition.lifetime) {
      case "singleton":
        return this.resolveSingleton<T>(token, definition);
      case "scoped":
        return this.resolveScoped<T>(token, definition);
      case "transient":
        return this.createInstance<T>(token, definition);
      default:
        throw new JPClawError({
          code: ErrorCode.SYSTEM_INTERNAL,
          message: `Unknown service lifetime: ${definition.lifetime}`
        });
    }
  }

  private async resolveSingleton<T>(token: string, definition: ServiceDefinition): Promise<T> {
    let instance = this.singletonInstances.get(token);
    
    if (!instance) {
      const value = await this.createInstance<T>(token, definition);
      instance = {
        value,
        created: Date.now(),
        accessed: Date.now(),
        accessCount: 0
      };
      this.singletonInstances.set(token, instance);
    }

    instance.accessed = Date.now();
    instance.accessCount++;
    
    return instance.value as T;
  }

  private async resolveScoped<T>(token: string, definition: ServiceDefinition): Promise<T> {
    let instance = this.scopedInstances.get(token);
    
    if (!instance) {
      const value = await this.createInstance<T>(token, definition);
      instance = {
        value,
        created: Date.now(),
        accessed: Date.now(),
        accessCount: 0
      };
      this.scopedInstances.set(token, instance);
    }

    instance.accessed = Date.now();
    instance.accessCount++;
    
    return instance.value as T;
  }

  private async createInstance<T>(token: string, definition: ServiceDefinition): Promise<T> {
    this.creating.add(token);
    
    try {
      const instance = await definition.factory(this);
      return instance as T;
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.SYSTEM_INTERNAL,
        message: `Failed to create instance of service '${token}'`,
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    } finally {
      this.creating.delete(token);
    }
  }

  private detectCircularDependencies(): string[] {
    const issues: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (token: string, path: string[] = []): void => {
      if (visiting.has(token)) {
        const cycle = [...path, token].slice(path.indexOf(token));
        issues.push(`Circular dependency detected: ${cycle.join(' -> ')}`);
        return;
      }

      if (visited.has(token)) {
        return;
      }

      visiting.add(token);
      const definition = this.services.get(token);
      
      if (definition?.dependencies) {
        for (const dependency of definition.dependencies) {
          visit(dependency, [...path, token]);
        }
      }

      visiting.delete(token);
      visited.add(token);
    };

    for (const token of this.services.keys()) {
      visit(token);
    }

    return issues;
  }

  private recordResolutionTime(time: number): void {
    this.resolutionTimes.push(time);
    
    // 保留最近100次的记录
    if (this.resolutionTimes.length > 100) {
      this.resolutionTimes.shift();
    }
  }

  private calculateAverageResolutionTime(): number {
    if (this.resolutionTimes.length === 0) return 0;
    
    const sum = this.resolutionTimes.reduce((a, b) => a + b, 0);
    return sum / this.resolutionTimes.length;
  }
}

/**
 * 装饰器工厂
 */
export function injectable<T extends new (...args: any[]) => {}>(
  token?: string,
  lifetime: ServiceLifetime = "transient",
  dependencies?: string[]
) {
  return function (constructor: T): T {
    const serviceToken = token || constructor.name;
    
    // 在构造函数上添加元数据
    (constructor as any).__serviceToken = serviceToken;
    (constructor as any).__serviceLifetime = lifetime;
    (constructor as any).__serviceDependencies = dependencies;
    
    return constructor;
  };
}

/**
 * 服务装饰器
 */
export function service(
  token: string,
  lifetime: ServiceLifetime = "singleton"
) {
  return injectable(token, lifetime);
}

/**
 * 全局容器管理器
 */
export class ContainerManager {
  private static instance: ContainerManager;
  private containers = new Map<string, Container>();
  private defaultContainer: Container;

  private constructor() {
    this.defaultContainer = new Container("default");
    this.containers.set("default", this.defaultContainer);
    this.registerCoreServices();
  }

  static getInstance(): ContainerManager {
    if (!ContainerManager.instance) {
      ContainerManager.instance = new ContainerManager();
    }
    return ContainerManager.instance;
  }

  getContainer(name = "default"): Container {
    const container = this.containers.get(name);
    if (!container) {
      throw new JPClawError({
        code: ErrorCode.SYSTEM_INTERNAL,
        message: `Container '${name}' not found`
      });
    }
    return container;
  }

  createContainer(name: string): Container {
    if (this.containers.has(name)) {
      throw new JPClawError({
        code: ErrorCode.SYSTEM_INTERNAL,
        message: `Container '${name}' already exists`
      });
    }

    const container = new Container(name);
    this.containers.set(name, container);
    return container;
  }

  disposeContainer(name: string): boolean {
    if (name === "default") {
      throw new JPClawError({
        code: ErrorCode.SYSTEM_INTERNAL,
        message: "Cannot dispose default container"
      });
    }

    const container = this.containers.get(name);
    if (container) {
      container.dispose();
      this.containers.delete(name);
      return true;
    }
    return false;
  }

  getAllStats(): Record<string, ServiceStats> {
    const stats: Record<string, ServiceStats> = {};
    
    for (const [name, container] of this.containers) {
      stats[name] = container.getStats();
    }

    return stats;
  }

  private registerCoreServices(): void {
    const container = this.defaultContainer;
    
    // 注册核心服务的占位符
    // 实际使用时会被具体的服务实现替换
    
    container.registerSingleton("logger", (c) => {
      return { log, logError };
    });

    container.registerSingleton("metrics", (c) => {
      return metrics;
    });
  }
}

// 导出全局实例和便捷函数
export const containerManager = ContainerManager.getInstance();
export const defaultContainer = containerManager.getContainer("default");

export function resolve<T>(token: string, containerName = "default"): Promise<T> {
  return containerManager.getContainer(containerName).resolve<T>(token);
}

export function register<T>(
  token: string,
  factory: (container: Container) => T | Promise<T>,
  lifetime: ServiceLifetime = "singleton",
  containerName = "default"
): void {
  containerManager.getContainer(containerName).register({
    token,
    factory,
    lifetime
  });
}