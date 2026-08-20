import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import { registerSalesTools } from './tools.js'
import type { FileSystemLike, SalesConfig } from './types.js'

export const name = 'dsh-sales'
export const inject = ['tools', 'fs']

export type Config = SalesConfig

export const Config: Schema<SalesConfig> = Schema.object({
  defaultRoot: Schema.string().default('.'),
  reportDir: Schema.string().default('.dsh-sales/reports'),
  maxFiles: Schema.number().step(1).min(1).max(5_000).default(500),
  maxRows: Schema.number().step(1).min(1).max(500_000).default(100_000),
  maxFileBytes: Schema.number().step(1).min(1_024).max(10_485_760).default(1_048_576),
  maxTextChars: Schema.number().step(1).min(1_000).max(1_000_000).default(180_000),
  maxResultChars: Schema.number().step(1).min(1_000).max(200_000).default(50_000),
  defaultCurrency: Schema.string().default('CNY'),
  defaultTimezone: Schema.string().default('Asia/Shanghai'),
})

export function apply(ctx: Context, config: SalesConfig): void {
  const fs = (ctx as unknown as { fs: FileSystemLike }).fs
  registerSalesTools(ctx, config, fs)
  ctx.logger.info(`[${name}] registered sales tools for ${config.defaultRoot}`)
}
