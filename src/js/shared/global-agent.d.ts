/**
 * global-agent 类型声明
 */
declare module 'global-agent' {
  export interface ProxyConfiguration {
    HTTP_PROXY?: string;
    HTTPS_PROXY?: string;
    NO_PROXY?: string;
  }

  export function bootstrap(configuration?: ProxyConfiguration): void;
  export function createGlobalProxyAgent(configuration?: ProxyConfiguration): void;
}