/**
 * 技能执行沙箱系统
 * 提供安全的技能执行环境，限制资源使用和系统访问
 */

import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode } from "../shared/errors.js";
import { metrics } from "../monitoring/metrics.js";

export interface SandboxConfig {
  maxExecutionTimeMs: number;
  maxMemoryMB: number;
  maxCpuPercent: number;
  allowedModules: string[];
  allowedPaths: string[];
  networkAccess: boolean;
  fileSystemAccess: "none" | "read-only" | "restricted";
  maxOutputSize: number;
}

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  stats: {
    durationMs: number;
    memoryUsedMB: number;
    cpuUsageMs: number;
  };
}

export interface SkillExecution {
  id: string;
  skillName: string;
  startTime: number;
  timeoutHandle?: NodeJS.Timeout;
  process?: ChildProcess;
  worker?: Worker;
}

const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  maxExecutionTimeMs: 30000, // 30秒
  maxMemoryMB: 256, // 256MB
  maxCpuPercent: 50, // 50% CPU
  // P1-NEW-3修复: 收紧沙箱模块白名单（移除 stream、crypto 等高风险模块）
  allowedModules: [
    "util", "path", "url", "querystring",
    "events", "buffer", "string_decoder"
  ],
  allowedPaths: [
    "skills/",
    "sessions/",
    "tmp/"
  ],
  networkAccess: false,
  fileSystemAccess: "restricted",
  maxOutputSize: 10 * 1024 * 1024 // 10MB
};

export class SkillSandbox {
  private static instance: SkillSandbox;
  private config: SandboxConfig;
  private activeExecutions = new Map<string, SkillExecution>();

  private constructor(config: SandboxConfig = DEFAULT_SANDBOX_CONFIG) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  static getInstance(config?: SandboxConfig): SkillSandbox {
    if (!SkillSandbox.instance) {
      SkillSandbox.instance = new SkillSandbox(config);
    }
    return SkillSandbox.instance;
  }

  /**
   * 在沙箱中执行技能
   */
  async executeSkill(
    skillName: string,
    skillPath: string,
    input: string,
    customConfig?: Partial<SandboxConfig>
  ): Promise<ExecutionResult> {
    const config = { ...this.config, ...customConfig };
    const executionId = this.generateExecutionId();
    
    const execution: SkillExecution = {
      id: executionId,
      skillName,
      startTime: Date.now()
    };

    this.activeExecutions.set(executionId, execution);

    try {
      metrics.increment("sandbox.executions.started", 1, {
        skill: skillName,
        type: path.extname(skillPath).slice(1)
      });

      // 根据文件类型选择执行方式
      let result: ExecutionResult;
      
      if (skillPath.endsWith('.js') || skillPath.endsWith('.mjs')) {
        result = await this.executeJavaScriptSkill(execution, skillPath, input, config);
      } else if (skillPath.endsWith('.py')) {
        result = await this.executePythonSkill(execution, skillPath, input, config);
      } else if (skillPath.endsWith('.sh')) {
        result = await this.executeShellSkill(execution, skillPath, input, config);
      } else {
        throw new JPClawError({
          code: ErrorCode.SKILL_EXECUTION_FAILED,
          message: `Unsupported skill file type: ${path.extname(skillPath)}`
        });
      }

      metrics.histogram("sandbox.execution.duration", result.stats.durationMs, {
        skill: skillName,
        success: result.success.toString()
      });

      metrics.histogram("sandbox.execution.memory", result.stats.memoryUsedMB, {
        skill: skillName
      });

      if (result.success) {
        metrics.increment("sandbox.executions.success", 1, { skill: skillName });
      } else {
        metrics.increment("sandbox.executions.failed", 1, { skill: skillName });
      }

      return result;

    } catch (error) {
      metrics.increment("sandbox.executions.error", 1, {
        skill: skillName,
        error: error instanceof Error ? error.constructor.name : "unknown"
      });

      const duration = Date.now() - execution.startTime;
      
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        stats: {
          durationMs: duration,
          memoryUsedMB: 0,
          cpuUsageMs: 0
        }
      };
    } finally {
      this.cleanupExecution(executionId);
    }
  }

  /**
   * 执行 JavaScript 技能
   */
  private async executeJavaScriptSkill(
    execution: SkillExecution,
    skillPath: string,
    input: string,
    config: SandboxConfig
  ): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const workerCode = this.generateWorkerCode(skillPath, config);
      const tempWorkerPath = path.join(process.cwd(), 'tmp', `worker_${execution.id}.js`);

      try {
        // 确保临时目录存在
        fs.mkdirSync(path.dirname(tempWorkerPath), { recursive: true });
        
        // 写入 Worker 代码
        fs.writeFileSync(tempWorkerPath, workerCode);

        // 创建 Worker
        const worker = new Worker(tempWorkerPath, {
          workerData: { skillPath, input },
          resourceLimits: {
            maxOldGenerationSizeMb: config.maxMemoryMB,
            maxYoungGenerationSizeMb: Math.floor(config.maxMemoryMB * 0.1),
            codeRangeSizeMb: Math.floor(config.maxMemoryMB * 0.1)
          }
        });

        execution.worker = worker;

        // 设置超时
        const timeout = setTimeout(() => {
          worker.terminate();
          reject(new JPClawError({
            code: ErrorCode.SKILL_TIMEOUT,
            message: `Skill execution timed out after ${config.maxExecutionTimeMs}ms`
          }));
        }, config.maxExecutionTimeMs);

        execution.timeoutHandle = timeout;

        let outputSize = 0;
        let output = "";

        worker.on('message', (data) => {
          if (data.type === 'result') {
            clearTimeout(timeout);
            
            const result: ExecutionResult = {
              success: data.success,
              output: data.output,
              error: data.error,
              stats: {
                durationMs: Date.now() - startTime,
                memoryUsedMB: data.memoryUsage || 0,
                cpuUsageMs: data.cpuUsage || 0
              }
            };
            
            resolve(result);
          } else if (data.type === 'output') {
            outputSize += Buffer.byteLength(data.chunk, 'utf8');
            if (outputSize > config.maxOutputSize) {
              worker.terminate();
              reject(new JPClawError({
                code: ErrorCode.SKILL_EXECUTION_FAILED,
                message: "Skill output exceeded maximum size limit"
              }));
              return;
            }
            output += data.chunk;
          }
        });

        worker.on('error', (error) => {
          clearTimeout(timeout);
          reject(new JPClawError({
            code: ErrorCode.SKILL_EXECUTION_FAILED,
            message: `Worker error: ${error.message}`,
            cause: error
          }));
        });

        worker.on('exit', (code) => {
          clearTimeout(timeout);
          if (code !== 0) {
            reject(new JPClawError({
              code: ErrorCode.SKILL_EXECUTION_FAILED,
              message: `Worker exited with code ${code}`
            }));
          }
        });

      } catch (error) {
        reject(error);
      } finally {
        // 清理临时文件
        try {
          if (fs.existsSync(tempWorkerPath)) {
            fs.unlinkSync(tempWorkerPath);
          }
        } catch (cleanupError) {
          log("warn", "Failed to cleanup worker file", { 
            error: String(cleanupError),
            path: tempWorkerPath
          });
        }
      }
    });
  }

  /**
   * 执行 Python 技能
   */
  private async executePythonSkill(
    execution: SkillExecution,
    skillPath: string,
    input: string,
    config: SandboxConfig
  ): Promise<ExecutionResult> {
    return this.executeProcessSkill(execution, 'python3', [skillPath], input, config);
  }

  /**
   * 执行 Shell 技能
   */
  private async executeShellSkill(
    execution: SkillExecution,
    skillPath: string,
    input: string,
    config: SandboxConfig
  ): Promise<ExecutionResult> {
    return this.executeProcessSkill(execution, 'bash', [skillPath], input, config);
  }

  /**
   * 执行进程技能（通用方法）
   */
  private async executeProcessSkill(
    execution: SkillExecution,
    command: string,
    args: string[],
    input: string,
    config: SandboxConfig
  ): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const startUsage = process.cpuUsage();

      const proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.createSandboxEnvironment(config),
        cwd: process.cwd(),
        timeout: config.maxExecutionTimeMs
      });

      execution.process = proc;

      let stdout = "";
      let stderr = "";
      let outputSize = 0;

      // 设置超时
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new JPClawError({
          code: ErrorCode.SKILL_TIMEOUT,
          message: `Process execution timed out after ${config.maxExecutionTimeMs}ms`
        }));
      }, config.maxExecutionTimeMs);

      execution.timeoutHandle = timeout;

      proc.stdout?.on('data', (data) => {
        const chunk = data.toString();
        outputSize += Buffer.byteLength(chunk, 'utf8');
        
        if (outputSize > config.maxOutputSize) {
          proc.kill('SIGKILL');
          reject(new JPClawError({
            code: ErrorCode.SKILL_EXECUTION_FAILED,
            message: "Process output exceeded maximum size limit"
          }));
          return;
        }
        
        stdout += chunk;
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        
        const endUsage = process.cpuUsage(startUsage);
        const duration = Date.now() - startTime;
        
        const result: ExecutionResult = {
          success: code === 0,
          output: stdout,
          error: stderr || undefined,
          stats: {
            durationMs: duration,
            memoryUsedMB: 0, // 无法从外部精确测量子进程内存
            cpuUsageMs: (endUsage.user + endUsage.system) / 1000
          }
        };
        
        resolve(result);
      });

      proc.on('error', (error) => {
        clearTimeout(timeout);
        reject(new JPClawError({
          code: ErrorCode.SKILL_EXECUTION_FAILED,
          message: `Process error: ${error.message}`,
          cause: error
        }));
      });

      // 发送输入数据
      if (input) {
        proc.stdin?.write(input);
        proc.stdin?.end();
      }
    });
  }

  /**
   * 生成 Worker 代码
   */
  private generateWorkerCode(skillPath: string, config: SandboxConfig): string {
    return `
const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');

// 限制模块访问
const originalRequire = require;
require = function(id) {
  const allowedModules = ${JSON.stringify(config.allowedModules)};
  
  if (!allowedModules.includes(id) && !id.startsWith('./') && !id.startsWith('../')) {
    throw new Error(\`Module '\${id}' is not allowed in sandbox\`);
  }
  
  return originalRequire(id);
};

// 限制文件系统访问
if (${JSON.stringify(config.fileSystemAccess)} !== 'none') {
  const originalReadFile = fs.readFile;
  const originalWriteFile = fs.writeFile;
  const allowedPaths = ${JSON.stringify(config.allowedPaths)};
  
  const checkPath = (filepath) => {
    const resolved = path.resolve(filepath);
    const allowed = allowedPaths.some(allowedPath => 
      resolved.startsWith(path.resolve(allowedPath))
    );
    if (!allowed) {
      throw new Error(\`Path '\${filepath}' is not allowed in sandbox\`);
    }
  };

  fs.readFile = function(filepath, ...args) {
    checkPath(filepath);
    return originalReadFile(filepath, ...args);
  };

  if (${JSON.stringify(config.fileSystemAccess)} === 'restricted') {
    fs.writeFile = function(filepath, ...args) {
      checkPath(filepath);
      return originalWriteFile(filepath, ...args);
    };
  } else {
    fs.writeFile = function() {
      throw new Error('File writing is not allowed in sandbox');
    };
  }
}

// 禁用网络访问
if (!${config.networkAccess}) {
  global.fetch = function() {
    throw new Error('Network access is not allowed in sandbox');
  };
  
  if (typeof XMLHttpRequest !== 'undefined') {
    XMLHttpRequest = function() {
      throw new Error('Network access is not allowed in sandbox');
    };
  }
}

// 执行技能
async function executeSkill() {
  const startTime = Date.now();
  const startMemory = process.memoryUsage();
  
  try {
    const skillModule = require(path.resolve(workerData.skillPath));
    const handler = skillModule.run || skillModule.default || skillModule;
    
    if (typeof handler !== 'function') {
      throw new Error('Skill must export a function');
    }
    
    const result = await handler(workerData.input);
    
    const endMemory = process.memoryUsage();
    const memoryUsed = (endMemory.heapUsed - startMemory.heapUsed) / 1024 / 1024;
    
    parentPort.postMessage({
      type: 'result',
      success: true,
      output: typeof result === 'string' ? result : JSON.stringify(result),
      memoryUsage: memoryUsed
    });
  } catch (error) {
    parentPort.postMessage({
      type: 'result',
      success: false,
      output: '',
      error: error.message
    });
  }
}

executeSkill().catch(error => {
  parentPort.postMessage({
    type: 'result',
    success: false,
    output: '',
    error: error.message
  });
});
`;
  }

  /**
   * 创建沙箱环境变量
   */
  private createSandboxEnvironment(config: SandboxConfig): Record<string, string> {
    const env: Record<string, string> = {
      NODE_ENV: 'sandbox',
      PATH: '/usr/bin:/bin', // 限制 PATH
    };

    // 移除敏感环境变量
    const sensitiveVars = [
      'ANTHROPIC_AUTH_TOKEN',
      'OPENAI_API_KEY', 
      'JPCLAW_ADMIN_TOKEN',
      'HOME',
      'USER'
    ];

    for (const [key, value] of Object.entries(process.env)) {
      if (!sensitiveVars.includes(key) && typeof value === 'string') {
        env[key] = value;
      }
    }

    return env;
  }

  /**
   * 生成执行 ID
   */
  private generateExecutionId(): string {
    return `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 清理执行资源
   */
  private cleanupExecution(executionId: string): void {
    const execution = this.activeExecutions.get(executionId);
    if (!execution) return;

    // 清理超时处理器
    if (execution.timeoutHandle) {
      clearTimeout(execution.timeoutHandle);
    }

    // 终止 Worker
    if (execution.worker) {
      execution.worker.terminate();
    }

    // P0-NEW-3修复: 杀死进程，保存延迟清理 handle 以便取消
    if (execution.process && !execution.process.killed) {
      execution.process.kill('SIGTERM');

      // 保存 SIGKILL 延迟 handle，以便进程正常退出时取消
      const sigkillHandle = setTimeout(() => {
        try {
          if (execution.process && !execution.process.killed) {
            execution.process.kill('SIGKILL');
            log("warn", "sandbox.process.force_killed", { executionId });
          }
        } catch {
          // 进程已退出，忽略
        }
      }, 5000);

      // 监听进程退出事件，立即取消延迟 SIGKILL
      execution.process.once('exit', () => {
        clearTimeout(sigkillHandle);
      });
    }

    this.activeExecutions.delete(executionId);

    metrics.gauge("sandbox.active_executions", this.activeExecutions.size);
  }

  /**
   * 强制终止所有执行
   */
  terminateAll(): void {
    for (const executionId of this.activeExecutions.keys()) {
      this.cleanupExecution(executionId);
    }
  }

  /**
   * 获取活动执行统计
   */
  getActiveExecutions(): SkillExecution[] {
    return Array.from(this.activeExecutions.values());
  }

  /**
   * 获取沙箱统计信息
   */
  getStats(): Record<string, unknown> {
    return {
      activeExecutions: this.activeExecutions.size,
      config: this.config,
      executions: Array.from(this.activeExecutions.values()).map(exec => ({
        id: exec.id,
        skillName: exec.skillName,
        durationMs: Date.now() - exec.startTime
      }))
    };
  }
}

// 导出全局实例
export const skillSandbox = SkillSandbox.getInstance();