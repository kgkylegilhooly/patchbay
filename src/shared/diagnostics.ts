/** What Settings › About shows, and the calls behind Copy diagnostics. Served in src/main/diagnostics/setup.ts. */

/** Baked in at build time by electron.vite.config.ts. See src/main/diagnostics/buildInfo.ts. */
export interface BuildInfo {
  /** The short commit, or "unknown" when the build wasn't made from a git checkout. */
  commit: string
  /** The checkout had changes not in that commit. */
  dirty: boolean
  branch: string
  /** ISO time the build was made. */
  date: string
}

export interface AgentProgramInfo {
  kind: 'claude' | 'codex'
  name: string
  /** What runs it: the program found on PATH, or the command or terminal program set in Settings. Home is redacted. */
  program: string | null
  /** "2.1.150", or why there's none, as "not asked (custom command)". */
  version: string
  /** Why it can't start, as the New form says it. */
  problem?: string
}

export interface AboutInfo {
  version: string
  build: BuildInfo
  electron: string
  node: string
  chrome: string
  os: string
}

/** Main's diagnostics calls, as window.patchbayDiagnostics. */
export interface DiagnosticsBridge {
  about(): Promise<AboutInfo>
  /** Asks each enabled agent's program for its version, off the main thread. Answers are kept for the app's run. */
  agents(): Promise<AgentProgramInfo[]>
  /** Builds the report and puts it on the clipboard. Says how many lines it has. */
  copy(): Promise<{ ok: true; lines: number } | { ok: false; reason: string }>
  openLogFolder(): Promise<void>
}
