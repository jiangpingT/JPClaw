/**
 * 为 global-agent 模块添加类型声明
 */

declare module "global-agent" {
  export interface ProxyAgentConfigurationInputType {
    environmentVariableNamespace?: string;
    forceGlobalAgent?: boolean;
  }

  export function bootstrap(options?: ProxyAgentConfigurationInputType): void;
  export function createProxyController(): any;
  
  export const GLOBAL_AGENT: {
    HTTP_PROXY: string | null;
    HTTPS_PROXY: string | null;
    NO_PROXY: string | null;
  };
}