/**
 * 连接池单元测试
 */

import { describe, it, expect, beforeEach, afterEach, vi, MockedFunction } from 'vitest';
import { ConnectionPool, type PooledConnection, type ConnectionFactory, type PoolConfig } from '../../../src/js/shared/connection-pool.js';

// Mock连接实现
class MockConnection implements PooledConnection {
  public id: string;
  public lastUsed: number = Date.now();
  public createdAt: number = Date.now();
  public useCount: number = 0;
  private _isAlive: boolean = true;

  constructor(id?: string) {
    this.id = id || `mock_${Math.random().toString(36).slice(2)}`;
  }

  isAlive(): boolean {
    return this._isAlive;
  }

  async reset(): Promise<void> {
    // Mock reset logic
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  async destroy(): Promise<void> {
    this._isAlive = false;
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  // Test helper methods
  kill(): void {
    this._isAlive = false;
  }
}

// Mock连接工厂
class MockConnectionFactory implements ConnectionFactory<MockConnection> {
  private createCount = 0;
  private shouldFailCreation = false;
  private shouldFailValidation = false;

  async create(): Promise<MockConnection> {
    if (this.shouldFailCreation) {
      throw new Error('Mock creation failure');
    }
    
    this.createCount++;
    await new Promise(resolve => setTimeout(resolve, 10)); // 模拟异步创建
    return new MockConnection(`mock_${this.createCount}`);
  }

  async validate(connection: MockConnection): Promise<boolean> {
    if (this.shouldFailValidation) {
      return false;
    }
    
    return connection.isAlive();
  }

  async destroy(connection: MockConnection): Promise<void> {
    await connection.destroy();
  }

  // Test helpers
  getCreateCount(): number {
    return this.createCount;
  }

  setFailCreation(fail: boolean): void {
    this.shouldFailCreation = fail;
  }

  setFailValidation(fail: boolean): void {
    this.shouldFailValidation = fail;
  }
}

describe('ConnectionPool', () => {
  let pool: ConnectionPool<MockConnection>;
  let factory: MockConnectionFactory;
  let config: PoolConfig;

  beforeEach(() => {
    factory = new MockConnectionFactory();
    config = {
      minConnections: 2,
      maxConnections: 5,
      acquireTimeout: 5000,
      idleTimeout: 60000,
      maxLifetime: 300000,
      testInterval: 10000,
      maxRetries: 3
    };
    pool = new ConnectionPool(factory, config, 'test-pool');
  });

  afterEach(async () => {
    await pool.close();
  });

  describe('initialization', () => {
    it('should create minimum connections on startup', async () => {
      // Wait for pre-warming
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const stats = pool.getStats();
      expect(stats.totalConnections).toBe(config.minConnections);
      expect(stats.idleConnections).toBe(config.minConnections);
    });
  });

  describe('acquire and release', () => {
    it('should acquire and release connections', async () => {
      const connection = await pool.acquire();
      
      expect(connection).toBeInstanceOf(MockConnection);
      expect(connection.isAlive()).toBe(true);
      
      const statsAcquired = pool.getStats();
      expect(statsAcquired.activeConnections).toBe(1);
      expect(statsAcquired.idleConnections).toBe(config.minConnections - 1);
      
      await pool.release(connection);
      
      const statsReleased = pool.getStats();
      expect(statsReleased.activeConnections).toBe(0);
      expect(statsReleased.idleConnections).toBe(config.minConnections);
    });

    it('should create new connection when none available', async () => {
      // Acquire all minimum connections
      const connections: MockConnection[] = [];
      for (let i = 0; i < config.minConnections; i++) {
        connections.push(await pool.acquire());
      }

      // Acquire one more (should create new)
      const extraConnection = await pool.acquire();
      expect(extraConnection).toBeInstanceOf(MockConnection);
      
      const stats = pool.getStats();
      expect(stats.totalConnections).toBe(config.minConnections + 1);
      
      // Release all
      for (const conn of connections) {
        await pool.release(conn);
      }
      await pool.release(extraConnection);
    });

    it('should queue requests when max connections reached', async () => {
      // Acquire max connections
      const connections: MockConnection[] = [];
      for (let i = 0; i < config.maxConnections; i++) {
        connections.push(await pool.acquire());
      }

      // Try to acquire one more (should queue)
      const acquirePromise = pool.acquire();
      
      // Release one connection
      setTimeout(async () => {
        await pool.release(connections[0]);
      }, 100);

      const queuedConnection = await acquirePromise;
      expect(queuedConnection).toBeInstanceOf(MockConnection);
      
      // Cleanup
      for (let i = 1; i < connections.length; i++) {
        await pool.release(connections[i]);
      }
      await pool.release(queuedConnection);
    });

    it('should timeout when acquire takes too long', async () => {
      // Use short timeout config
      const shortTimeoutConfig = { ...config, acquireTimeout: 100 };
      const timeoutPool = new ConnectionPool(factory, shortTimeoutConfig, 'timeout-test');

      try {
        // Acquire all connections
        const connections: MockConnection[] = [];
        for (let i = 0; i < shortTimeoutConfig.maxConnections; i++) {
          connections.push(await timeoutPool.acquire());
        }

        // This should timeout
        await expect(timeoutPool.acquire()).rejects.toThrow('timeout');

        // Cleanup
        for (const conn of connections) {
          await timeoutPool.release(conn);
        }
      } finally {
        await timeoutPool.close();
      }
    });

    it('should handle connection validation failure', async () => {
      const connection = await pool.acquire();
      
      // Make validation fail
      factory.setFailValidation(true);
      
      // This should destroy the connection instead of returning to pool
      await pool.release(connection);
      
      const stats = pool.getStats();
      expect(stats.idleConnections).toBeLessThan(config.minConnections);
      
      factory.setFailValidation(false);
    });

    it('should handle dead connections', async () => {
      const connection = await pool.acquire();
      
      // Kill the connection
      (connection as MockConnection).kill();
      
      await pool.release(connection);
      
      // Pool should have detected the dead connection and not returned it
      const stats = pool.getStats();
      expect(stats.totalConnections).toBeLessThan(config.minConnections + 1);
    });
  });

  describe('health check and cleanup', () => {
    it('should maintain minimum connections', async () => {
      // Wait for initial setup
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const initialStats = pool.getStats();
      expect(initialStats.totalConnections).toBe(config.minConnections);
      
      // Manually destroy a connection (simulate failure)
      const connection = await pool.acquire();
      await pool.destroy(connection);
      
      // Trigger health check
      await new Promise(resolve => setTimeout(resolve, config.testInterval + 100));
      
      const finalStats = pool.getStats();
      expect(finalStats.totalConnections).toBe(config.minConnections);
    });

    it('should clean up expired connections', async () => {
      // Create pool with short max lifetime
      const shortLifetimeConfig = { ...config, maxLifetime: 100 };
      const lifecyclePool = new ConnectionPool(factory, shortLifetimeConfig, 'lifecycle-test');

      try {
        // Wait for connections to be created and then expire
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Trigger health check
        await new Promise(resolve => setTimeout(resolve, shortLifetimeConfig.testInterval + 100));
        
        // Should have recreated connections due to expiry
        const stats = lifecyclePool.getStats();
        expect(stats.totalConnections).toBe(shortLifetimeConfig.minConnections);
      } finally {
        await lifecyclePool.close();
      }
    });
  });

  describe('statistics and monitoring', () => {
    it('should track connection statistics', async () => {
      const connection1 = await pool.acquire();
      const connection2 = await pool.acquire();
      
      const stats = pool.getStats();
      expect(stats.totalConnections).toBeGreaterThanOrEqual(2);
      expect(stats.activeConnections).toBe(2);
      expect(stats.totalAcquired).toBe(2);
      
      await pool.release(connection1);
      await pool.release(connection2);
      
      const finalStats = pool.getStats();
      expect(finalStats.totalReleased).toBe(2);
      expect(finalStats.activeConnections).toBe(0);
    });

    it('should calculate average resolution time', async () => {
      // Acquire and release several connections
      for (let i = 0; i < 5; i++) {
        const connection = await pool.acquire();
        await pool.release(connection);
      }
      
      const stats = pool.getStats();
      expect(stats.averageResolutionTime).toBeGreaterThan(0);
    });
  });

  describe('error handling', () => {
    it('should handle factory creation failures', async () => {
      factory.setFailCreation(true);
      
      await expect(pool.acquire()).rejects.toThrow();
      
      factory.setFailCreation(false);
    });

    it('should handle connection reset failures', async () => {
      const connection = await pool.acquire();
      
      // Mock reset failure
      const originalReset = connection.reset;
      connection.reset = vi.fn().mockRejectedValue(new Error('Reset failed'));
      
      // Should destroy connection instead of reusing it
      await pool.release(connection);
      
      const stats = pool.getStats();
      expect(stats.totalDestroyed).toBeGreaterThan(0);
      
      // Restore original method
      connection.reset = originalReset;
    });

    it('should handle unknown connection releases gracefully', async () => {
      const unknownConnection = new MockConnection('unknown');
      
      // Should not throw error
      await expect(pool.release(unknownConnection)).resolves.toBeUndefined();
    });
  });

  describe('pool closure', () => {
    it('should close pool and cleanup all connections', async () => {
      const connection1 = await pool.acquire();
      const connection2 = await pool.acquire();
      
      await pool.close();
      
      // Pool should be closed and connections destroyed
      expect(connection1.isAlive()).toBe(false);
      expect(connection2.isAlive()).toBe(false);
      
      // Further operations should fail
      await expect(pool.acquire()).rejects.toThrow('closing');
    });

    it('should reject pending requests on closure', async () => {
      // Acquire all connections
      const connections: MockConnection[] = [];
      for (let i = 0; i < config.maxConnections; i++) {
        connections.push(await pool.acquire());
      }

      // Queue a request
      const pendingPromise = pool.acquire();
      
      // Close pool
      await pool.close();
      
      // Pending request should be rejected
      await expect(pendingPromise).rejects.toThrow('closing');
      
      // Connections should be destroyed
      for (const conn of connections) {
        expect(conn.isAlive()).toBe(false);
      }
    });
  });
});