import type { OperationResult } from "../shared/operation-result.js";
import { createSuccess, wrapPromise } from "../shared/operation-result.js";
import { ErrorCode } from "../shared/errors.js";

export type ReplyContext = {
  userId?: string;
  userName?: string;
  channelId?: string;
  traceId?: string;
  agentId?: string; // Discord协作bot的角色ID (expert/critic/thinker)
};

export interface ChatEngine {
  reply(input: string, context?: ReplyContext): Promise<string>;
  // Persist a deterministic (non-model) exchange into the same session context/transcript.
  // This prevents context loss when a request is handled by a "route" (web/skills/etc.)
  // rather than by the main agent reply path.
  recordExternalExchange?(input: string, output: string, context?: ReplyContext): void;
}

/**
 * 阶段2.2：扩展接口，支持 OperationResult
 */
export interface ChatEngineV2 extends ChatEngine {
  replyV2(input: string, context?: ReplyContext): Promise<OperationResult<string>>;
}

/**
 * 阶段2.2：包装旧接口为新接口
 */
export function wrapChatEngine(engine: ChatEngine): ChatEngineV2 {
  return {
    ...engine,
    async replyV2(input: string, context?: ReplyContext): Promise<OperationResult<string>> {
      return wrapPromise(
        engine.reply(input, context),
        (error) => ({
          code: ErrorCode.SYSTEM_INTERNAL,
          message: String(error),
          context: { originalError: error }
        } as any)
      );
    }
  };
}
