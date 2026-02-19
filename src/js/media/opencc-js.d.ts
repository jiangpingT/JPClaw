/**
 * TypeScript 类型声明文件 for opencc-js
 */
declare module 'opencc-js' {
  export interface ConverterOptions {
    from: string;
    to: string;
  }

  export function Converter(options: ConverterOptions): (text: string) => string;

  export default {
    Converter
  };
}
