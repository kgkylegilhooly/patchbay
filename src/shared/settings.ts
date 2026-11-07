/** What settings.json holds. An absent field means the default. */
export interface Settings {
  /** The shell for new terminals. */
  shell?: string
  permissionMode?: string
  /** The program that starts Claude, such as Git Bash or PowerShell. Absent means run Claude directly. */
  claudeTerminal?: string
  /** What to run instead of `claude`. Patchbay's options go at the end, or where it says {args}. */
  claudeCommand?: string
  /** 'codex' makes Codex the agent that new teams and patchbay open-agent use when none is named. Claude otherwise. */
  defaultAgent?: string
  /** What to run instead of `codex`, the same way as claudeCommand. */
  codexCommand?: string
  /** Where updates come from: github:owner/repo, or an https address holding latest.yml. Empty means no updates. */
  updateFeed?: string
  /** 'off' stops the check at start and every few hours. Check now still works. */
  updateCheck?: string
  /**
   * Name prefixes of environment variables kept out of sessions, separated by spaces or commas, as `OTHERAPP_`. For
   * when Patchbay is started from inside another app whose sessions must not think they own Patchbay's.
   */
  envNotPassed?: string
  /** 'off' turns off Windows notifications. They're on otherwise. */
  notifications?: string
  /** 'off' turns off the chime. It's on otherwise. */
  sound?: string
  /** 'off' lets the PC sleep while an agent is working. It's kept awake otherwise. */
  keepAwake?: string
  /** Where the usage pill reads from: 'claude' (the default), 'endpoint', 'page' or 'off'. */
  usageSource?: string
  usageUrl?: string
  usageUsedPath?: string
  usageLimitPath?: string
  usageUsedPattern?: string
  usageLimitPattern?: string
  /** A fixed limit, such as 150. */
  usageLimit?: string
  /** 'none' means no unit. */
  usageUnit?: string
  /** 'none' means no label. */
  usagePeriod?: string
  usageRefreshMinutes?: string
}

/** With no terminal there's no shell to understand these, and they'd reach Claude as plain arguments. */
export function needsTerminal(command: string): boolean {
  return /&&|\|\||[|;<>]|^\s*\w+=/.test(command)
}
