import Schema from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";

//#region src/types.d.ts

interface SalesConfig {
  defaultRoot: string;
  reportDir: string;
  maxFiles: number;
  maxRows: number;
  maxFileBytes: number;
  maxTextChars: number;
  maxResultChars: number;
  defaultCurrency: string;
  defaultTimezone: string;
}
//#endregion
//#region src/index.d.ts
declare const name = "dsh-sales";
declare const inject: string[];
type Config = SalesConfig;
declare const Config: Schema<SalesConfig>;
declare function apply(ctx: Context, config: SalesConfig): void;
//#endregion
export { Config, apply, inject, name };