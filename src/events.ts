declare module '@deepseek-ai/cordis' {
  interface Events {
    'sales/analysis-completed'(payload: { kind: string; source: string; warningCount: number }): void
    'sales/report-previewed'(payload: { path: string }): void
    'sales/report-applied'(payload: { path: string }): void
  }
}
