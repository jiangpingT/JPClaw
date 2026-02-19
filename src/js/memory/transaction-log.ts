/**
 * 事务日志 - 提供简单的事务性保证
 * 用于记忆更新操作的回滚支持
 */

import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode } from "../shared/errors.js";
import type { IVectorStore } from "./enhanced-memory-manager.js";

export interface TransactionOperation {
  type: 'add' | 'remove' | 'update' | 'resolve_conflict';
  vectorId: string;
  vector?: any; // 用于回滚时恢复
  previousState?: any; // P0-7: 记录操作前的状态
  timestamp: number; // P0-7: 操作时间戳
  metadata?: Record<string, unknown>; // P0-7: 额外的上下文信息
}

/**
 * 事务日志类 - 记录操作并支持回滚
 * P0-7 改进：完整的状态记录和恢复机制
 */
export class TransactionLog {
  private operations: TransactionOperation[] = [];
  private vectorStore: IVectorStore;
  private readonly transactionId: string; // P0-7: 唯一事务ID
  private readonly startTime: number; // P0-7: 事务开始时间
  private checkpoints: Map<string, number> = new Map(); // P0-7: 检查点支持

  constructor(vectorStore: IVectorStore) {
    this.vectorStore = vectorStore;
    this.transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.startTime = Date.now();

    log("debug", "transaction.created", {
      transactionId: this.transactionId,
      timestamp: this.startTime
    });
  }

  /**
   * 记录添加操作
   * P0-7 改进：添加时间戳和上下文
   */
  recordAdd(vectorId: string, metadata?: Record<string, unknown>): void {
    this.operations.push({
      type: 'add',
      vectorId,
      timestamp: Date.now(),
      metadata
    });

    log("debug", "transaction.record.add", {
      transactionId: this.transactionId,
      vectorId,
      operationIndex: this.operations.length - 1
    });
  }

  /**
   * 记录删除操作（保存被删除的向量以便恢复）
   * P0-7 改进：完整记录被删除向量的状态
   */
  recordRemove(vectorId: string, vector: any, metadata?: Record<string, unknown>): void {
    this.operations.push({
      type: 'remove',
      vectorId,
      vector, // 保存完整的向量对象用于恢复
      timestamp: Date.now(),
      metadata
    });

    log("debug", "transaction.record.remove", {
      transactionId: this.transactionId,
      vectorId,
      operationIndex: this.operations.length - 1
    });
  }

  /**
   * P0-7 新增：记录更新操作
   * 保存更新前后的状态以支持回滚
   */
  recordUpdate(vectorId: string, previousState: any, newState: any, metadata?: Record<string, unknown>): void {
    this.operations.push({
      type: 'update',
      vectorId,
      previousState, // 回滚时恢复到这个状态
      vector: newState, // 当前的新状态
      timestamp: Date.now(),
      metadata
    });

    log("debug", "transaction.record.update", {
      transactionId: this.transactionId,
      vectorId,
      operationIndex: this.operations.length - 1
    });
  }

  /**
   * P0-7 新增：记录冲突解决操作
   */
  recordConflictResolution(vectorId: string, resolvedState: any, metadata?: Record<string, unknown>): void {
    this.operations.push({
      type: 'resolve_conflict',
      vectorId,
      vector: resolvedState,
      timestamp: Date.now(),
      metadata
    });

    log("debug", "transaction.record.conflict_resolution", {
      transactionId: this.transactionId,
      vectorId,
      operationIndex: this.operations.length - 1
    });
  }

  /**
   * P0-7 新增：创建检查点
   * 允许回滚到特定的检查点而不是完全回滚
   */
  createCheckpoint(name: string): void {
    this.checkpoints.set(name, this.operations.length);
    log("debug", "transaction.checkpoint.created", {
      transactionId: this.transactionId,
      checkpointName: name,
      operationCount: this.operations.length
    });
  }

  /**
   * 回滚所有记录的操作
   * P0-7 改进：支持部分回滚到检查点
   */
  async rollback(toCheckpoint?: string): Promise<void> {
    let targetIndex = 0;

    if (toCheckpoint) {
      const checkpointIndex = this.checkpoints.get(toCheckpoint);
      if (checkpointIndex === undefined) {
        throw new Error(`Checkpoint '${toCheckpoint}' not found`);
      }
      targetIndex = checkpointIndex;
      log("warn", "transaction.rollback.to_checkpoint", {
        transactionId: this.transactionId,
        checkpointName: toCheckpoint,
        operationsToRollback: this.operations.length - targetIndex
      });
    } else {
      log("warn", "transaction.rollback.start", {
        transactionId: this.transactionId,
        operationCount: this.operations.length,
        duration: Date.now() - this.startTime
      });
    }

    let rollbackErrors = 0;
    const opsToRollback = this.operations.slice(targetIndex).reverse();

    // 反向回滚操作
    for (const op of opsToRollback) {
      try {
        if (op.type === 'add') {
          // 回滚add：删除已添加的向量
          this.vectorStore.removeMemory(op.vectorId);
          log("debug", "transaction.rollback.remove", {
            transactionId: this.transactionId,
            vectorId: op.vectorId
          });
        } else if (op.type === 'remove' && op.vector) {
          // 回滚remove：恢复被删除的向量
          await this.vectorStore.addMemory(
            op.vector.content,
            op.vector.metadata,
            op.vector.metadata.importance
          );
          log("debug", "transaction.rollback.restore", {
            transactionId: this.transactionId,
            vectorId: op.vectorId
          });
        } else if (op.type === 'update' && op.previousState) {
          // P0-7: 回滚update：恢复到之前的状态
          await this.vectorStore.addMemory(
            op.previousState.content,
            op.previousState.metadata,
            op.previousState.metadata.importance
          );
          log("debug", "transaction.rollback.restore_previous_state", {
            transactionId: this.transactionId,
            vectorId: op.vectorId
          });
        } else if (op.type === 'resolve_conflict') {
          // P0-7: 回滚冲突解决：移除解决后的向量
          this.vectorStore.removeMemory(op.vectorId);
          log("debug", "transaction.rollback.undo_conflict_resolution", {
            transactionId: this.transactionId,
            vectorId: op.vectorId
          });
        }
      } catch (error) {
        rollbackErrors++;
        logError(new JPClawError({
          code: ErrorCode.MEMORY_OPERATION_FAILED,
          message: `Transaction rollback failed for operation ${op.type}`,
          cause: error instanceof Error ? error : undefined,
          context: {
            transactionId: this.transactionId,
            vectorId: op.vectorId,
            operationType: op.type
          }
        }));
      }
    }

    if (rollbackErrors > 0) {
      log("error", "transaction.rollback.partial_failure", {
        transactionId: this.transactionId,
        totalOperations: opsToRollback.length,
        rollbackErrors,
        successRate: ((opsToRollback.length - rollbackErrors) / opsToRollback.length * 100).toFixed(2) + '%'
      });
      throw new Error(`Transaction rollback partially failed: ${rollbackErrors}/${opsToRollback.length} errors`);
    }

    // 如果是部分回滚，删除回滚的操作
    if (toCheckpoint) {
      this.operations = this.operations.slice(0, targetIndex);
    } else {
      this.operations = [];
    }

    log("info", "transaction.rollback.complete", {
      transactionId: this.transactionId,
      operationsRolledBack: opsToRollback.length,
      duration: Date.now() - this.startTime
    });
  }

  /**
   * 提交事务（清空日志）
   * P0-7 改进：添加详细日志
   */
  commit(): void {
    log("info", "transaction.commit", {
      transactionId: this.transactionId,
      operationCount: this.operations.length,
      duration: Date.now() - this.startTime,
      checkpointCount: this.checkpoints.size
    });

    this.operations = [];
    this.checkpoints.clear();
  }

  /**
   * 获取操作数量
   */
  getOperationCount(): number {
    return this.operations.length;
  }

  /**
   * P0-7 新增：获取事务摘要
   */
  getSummary(): {
    transactionId: string;
    operationCount: number;
    duration: number;
    operations: Array<{ type: string; vectorId: string; timestamp: number }>;
  } {
    return {
      transactionId: this.transactionId,
      operationCount: this.operations.length,
      duration: Date.now() - this.startTime,
      operations: this.operations.map(op => ({
        type: op.type,
        vectorId: op.vectorId,
        timestamp: op.timestamp
      }))
    };
  }

  /**
   * P0-7 新增：获取事务ID
   */
  getTransactionId(): string {
    return this.transactionId;
  }
}
