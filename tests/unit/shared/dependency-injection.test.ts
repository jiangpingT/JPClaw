/**
 * 依赖注入容器单元测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Container, type ServiceDefinition, injectable, service } from '../../../src/js/shared/dependency-injection.js';

// 测试服务类
class MockLogger {
  private logs: string[] = [];

  log(message: string): void {
    this.logs.push(message);
  }

  getLogs(): string[] {
    return [...this.logs];
  }

  clear(): void {
    this.logs.length = 0;
  }
}

class MockDatabase {
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  dispose(): void {
    this.connected = false;
  }
}

class MockUserService {
  constructor(
    private logger: MockLogger,
    private database: MockDatabase
  ) {}

  async getUser(id: string): Promise<{ id: string; name: string }> {
    this.logger.log(`Getting user ${id}`);
    return { id, name: `User ${id}` };
  }
}

// 装饰器测试类
@injectable('decorated-service', 'singleton')
class DecoratedService {
  getValue(): string {
    return 'decorated';
  }
}

@service('named-service', 'transient')
class NamedService {
  private instanceId = Math.random().toString(36);

  getInstanceId(): string {
    return this.instanceId;
  }
}

describe('Container', () => {
  let container: Container;

  beforeEach(() => {
    container = new Container('test-container');
  });

  afterEach(() => {
    container.dispose();
  });

  describe('service registration', () => {
    it('should register singleton service', () => {
      container.registerSingleton('logger', () => new MockLogger());

      expect(container.isRegistered('logger')).toBe(true);
      expect(container.getRegisteredServices()).toContain('logger');
    });

    it('should register transient service', () => {
      container.registerTransient('database', () => new MockDatabase());

      expect(container.isRegistered('database')).toBe(true);
    });

    it('should register scoped service', () => {
      container.registerScoped('user-service', (c) => 
        new MockUserService(
          {} as MockLogger,
          {} as MockDatabase
        )
      );

      expect(container.isRegistered('user-service')).toBe(true);
    });

    it('should register service instance', () => {
      const loggerInstance = new MockLogger();
      container.registerInstance('logger', loggerInstance);

      expect(container.isRegistered('logger')).toBe(true);
    });

    it('should override existing service registration', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      container.registerSingleton('logger', () => new MockLogger());
      container.registerSingleton('logger', () => new MockLogger()); // Override

      expect(container.getRegisteredServices().filter(s => s === 'logger')).toHaveLength(1);
      
      consoleSpy.mockRestore();
    });
  });

  describe('service resolution', () => {
    beforeEach(() => {
      container.registerSingleton('logger', () => new MockLogger());
      container.registerSingleton('database', () => new MockDatabase());
      container.registerTransient('user-service', (c) => 
        new MockUserService(
          c.resolve('logger'),
          c.resolve('database')
        )
      );
    });

    it('should resolve singleton service', async () => {
      const logger1 = await container.resolve<MockLogger>('logger');
      const logger2 = await container.resolve<MockLogger>('logger');

      expect(logger1).toBeInstanceOf(MockLogger);
      expect(logger1).toBe(logger2); // Same instance
    });

    it('should resolve transient service', async () => {
      const service1 = await container.resolve<MockUserService>('user-service');
      const service2 = await container.resolve<MockUserService>('user-service');

      expect(service1).toBeInstanceOf(MockUserService);
      expect(service1).not.toBe(service2); // Different instances
    });

    it('should resolve service with dependencies', async () => {
      const userService = await container.resolve<MockUserService>('user-service');

      const user = await userService.getUser('123');
      expect(user).toEqual({ id: '123', name: 'User 123' });
    });

    it('should handle async factory functions', async () => {
      container.registerSingleton('async-service', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return new MockLogger();
      });

      const service = await container.resolve<MockLogger>('async-service');
      expect(service).toBeInstanceOf(MockLogger);
    });

    it('should throw error for unregistered service', async () => {
      await expect(container.resolve('nonexistent')).rejects.toThrow('not registered');
    });

    it('should return null for tryResolve with unregistered service', async () => {
      const result = await container.tryResolve('nonexistent');
      expect(result).toBeNull();
    });

    it('should return service for tryResolve with registered service', async () => {
      const result = await container.tryResolve<MockLogger>('logger');
      expect(result).toBeInstanceOf(MockLogger);
    });
  });

  describe('scoped services', () => {
    beforeEach(() => {
      container.registerScoped('scoped-service', () => new MockLogger());
    });

    it('should reuse scoped service within same scope', async () => {
      const service1 = await container.resolve<MockLogger>('scoped-service');
      const service2 = await container.resolve<MockLogger>('scoped-service');

      expect(service1).toBe(service2); // Same instance within scope
    });

    it('should create new instance after scope clear', async () => {
      const service1 = await container.resolve<MockLogger>('scoped-service');
      
      container.clearScope();
      
      const service2 = await container.resolve<MockLogger>('scoped-service');

      expect(service1).not.toBe(service2); // Different instance after scope clear
    });
  });

  describe('circular dependency detection', () => {
    it('should detect direct circular dependency', async () => {
      container.register({
        token: 'service-a',
        factory: (c) => c.resolve('service-b'),
        lifetime: 'transient'
      });

      container.register({
        token: 'service-b',
        factory: (c) => c.resolve('service-a'),
        lifetime: 'transient'
      });

      await expect(container.resolve('service-a')).rejects.toThrow('Circular dependency');
    });

    it('should detect indirect circular dependency', async () => {
      container.register({
        token: 'service-a',
        factory: (c) => c.resolve('service-b'),
        lifetime: 'transient'
      });

      container.register({
        token: 'service-b',
        factory: (c) => c.resolve('service-c'),
        lifetime: 'transient'
      });

      container.register({
        token: 'service-c',
        factory: (c) => c.resolve('service-a'),
        lifetime: 'transient'
      });

      await expect(container.resolve('service-a')).rejects.toThrow('Circular dependency');
    });
  });

  describe('dependency validation', () => {
    beforeEach(() => {
      container.register({
        token: 'service-with-deps',
        factory: (c) => new MockUserService(
          c.resolve('logger'),
          c.resolve('database')
        ),
        lifetime: 'singleton',
        dependencies: ['logger', 'database']
      });
    });

    it('should validate dependencies successfully', () => {
      container.registerSingleton('logger', () => new MockLogger());
      container.registerSingleton('database', () => new MockDatabase());

      const validation = container.validateDependencies();
      expect(validation.valid).toBe(true);
      expect(validation.issues).toHaveLength(0);
    });

    it('should detect missing dependencies', () => {
      // Only register logger, not database
      container.registerSingleton('logger', () => new MockLogger());

      const validation = container.validateDependencies();
      expect(validation.valid).toBe(false);
      expect(validation.issues.some(issue => issue.includes('database'))).toBe(true);
    });

    it('should detect circular dependencies in validation', () => {
      container.register({
        token: 'circular-a',
        factory: () => ({}),
        lifetime: 'singleton',
        dependencies: ['circular-b']
      });

      container.register({
        token: 'circular-b',
        factory: () => ({}),
        lifetime: 'singleton',
        dependencies: ['circular-a']
      });

      const validation = container.validateDependencies();
      expect(validation.valid).toBe(false);
      expect(validation.issues.some(issue => issue.includes('Circular dependency'))).toBe(true);
    });
  });

  describe('container hierarchy', () => {
    it('should create child container with inherited services', async () => {
      container.registerSingleton('logger', () => new MockLogger());
      
      const child = container.createChildContainer('child');
      
      expect(child.isRegistered('logger')).toBe(true);
      
      const logger = await child.resolve<MockLogger>('logger');
      expect(logger).toBeInstanceOf(MockLogger);
      
      child.dispose();
    });

    it('should allow child container to override parent services', async () => {
      container.registerSingleton('logger', () => {
        const logger = new MockLogger();
        logger.log('parent');
        return logger;
      });
      
      const child = container.createChildContainer('child');
      child.registerSingleton('logger', () => {
        const logger = new MockLogger();
        logger.log('child');
        return logger;
      });
      
      const parentLogger = await container.resolve<MockLogger>('logger');
      const childLogger = await child.resolve<MockLogger>('logger');
      
      expect(parentLogger.getLogs()).toContain('parent');
      expect(childLogger.getLogs()).toContain('child');
      
      child.dispose();
    });
  });

  describe('statistics and monitoring', () => {
    beforeEach(() => {
      container.registerSingleton('singleton-service', () => new MockLogger());
      container.registerTransient('transient-service', () => new MockDatabase());
      container.registerScoped('scoped-service', () => new MockUserService({} as any, {} as any));
    });

    it('should track service statistics', async () => {
      await container.resolve('singleton-service');
      await container.resolve('transient-service');
      await container.resolve('scoped-service');

      const stats = container.getStats();

      expect(stats.totalServices).toBe(3);
      expect(stats.singletons).toBe(1);
      expect(stats.transients).toBe(1);
      expect(stats.scoped).toBe(1);
      expect(stats.instances).toBe(2); // singleton + scoped
      expect(stats.accessCount).toBeGreaterThan(0);
    });

    it('should track resolution times', async () => {
      // Resolve services multiple times
      for (let i = 0; i < 5; i++) {
        await container.resolve('singleton-service');
      }

      const stats = container.getStats();
      expect(stats.averageResolutionTime).toBeGreaterThan(0);
    });

    it('should provide dependency graph', () => {
      container.register({
        token: 'service-with-deps',
        factory: () => ({}),
        lifetime: 'singleton',
        dependencies: ['singleton-service', 'transient-service']
      });

      const graph = container.getDependencyGraph();
      
      expect(graph['service-with-deps']).toEqual(['singleton-service', 'transient-service']);
      expect(graph['singleton-service']).toEqual([]);
    });
  });

  describe('disposal and cleanup', () => {
    it('should call dispose on services that support it', async () => {
      const database = new MockDatabase();
      const disposeSpy = vi.spyOn(database, 'dispose');

      container.registerInstance('database', database);
      
      await container.resolve('database'); // Ensure it's instantiated
      
      container.dispose();
      
      expect(disposeSpy).toHaveBeenCalled();
    });

    it('should handle disposal errors gracefully', async () => {
      const errorService = {
        dispose: () => {
          throw new Error('Disposal error');
        }
      };

      container.registerInstance('error-service', errorService);
      await container.resolve('error-service');

      // Should not throw
      expect(() => container.dispose()).not.toThrow();
    });

    it('should clear all data after disposal', async () => {
      await container.resolve('singleton-service');
      
      container.dispose();
      
      expect(container.getRegisteredServices()).toHaveLength(0);
      expect(container.getStats().totalServices).toBe(0);
    });
  });

  describe('decorators', () => {
    it('should work with injectable decorator', () => {
      // The decorator should have set metadata
      expect((DecoratedService as any).__serviceToken).toBe('decorated-service');
      expect((DecoratedService as any).__serviceLifetime).toBe('singleton');
    });

    it('should work with service decorator', () => {
      expect((NamedService as any).__serviceToken).toBe('named-service');
      expect((NamedService as any).__serviceLifetime).toBe('transient');
    });
  });

  describe('error handling', () => {
    it('should handle factory function errors', async () => {
      container.registerSingleton('error-service', () => {
        throw new Error('Factory error');
      });

      await expect(container.resolve('error-service')).rejects.toThrow('Factory error');
    });

    it('should handle async factory function errors', async () => {
      container.registerSingleton('async-error-service', async () => {
        throw new Error('Async factory error');
      });

      await expect(container.resolve('async-error-service')).rejects.toThrow('Async factory error');
    });

    it('should clear creating flag on factory error', async () => {
      container.registerSingleton('error-service', () => {
        throw new Error('Factory error');
      });

      await expect(container.resolve('error-service')).rejects.toThrow();
      
      // Should be able to try again
      container.registerSingleton('error-service', () => new MockLogger());
      const service = await container.resolve('error-service');
      expect(service).toBeInstanceOf(MockLogger);
    });
  });
});