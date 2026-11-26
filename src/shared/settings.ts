import type { TerminalProfile } from './terminalProfiles'

/** What settings.json holds. An absent field means the default. */
export interface Settings {
  /**
   * The shell run commands use. Before terminal profiles it was new terminals' too: with no `terminalProfiles` yet, it
   * stands in as the default profile. See shared/terminalProfiles.ts.
   */
  shell?: string
  /** Terminal profiles the person made. Built-in ones aren't saved. */
  terminalProfiles?: TerminalProfile[]
  /** The id of the profile new terminals start with. */
  defaultTerminalProfile?: string
  permissionMode?: string
  /** The program that starts Claude, such as Git Bash or PowerShell. Absent means run Claude directly. */
  claudeTerminal?: string
  /** What to run instead of `claude`. Patchbay's options go at the end, or where it says {args}. */
  claudeCommand?: string
  /** 'codex' makes Codex the agent that new teams and patchbay open-agent use when none is named. Claude otherwise. */
  defaultAgent?: string
  /**
   * Agents Patchbay may not start, separated by spaces or commas, as `codex`. Absent means every agent is on. At least
   * one stays on: see src/shared/agents.ts.
   */
  agentsOff?: string
  /** What to run instead of `codex`, the same way as claudeCommand. */
  codexCommand?: string
  /** What Codex may do without asking: '' (Codex's own default), 'never' or 'bypass'. */
  codexApproval?: string
  /** 'on' lets Claude nodes message other Claude sessions on this PC by Claude's own means. Off otherwise. */
  claudeNativeMessaging?: string
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
  /** 'off' keeps notifications to the plain words (Finished its turn, Needs you), without what the agent said or asks. */
  notificationText?: string
  /** 'on' holds every armed trigger: due runs are skipped, arming is kept (Work menu > Pause all triggers). */
  triggersPaused?: string
  /** Quiet hours, as HH:MM: Windows notifications are held and the chime is off from quietFrom up to quietTo. See main/quietHours.ts. */
  quietFrom?: string
  quietTo?: string
  /** F62: a key that works from any program, bringing Patchbay to the next agent needing you. Blank means off. */
  globalKey?: string
  /** 'off' turns off the chime. It's on otherwise. */
  sound?: string
  /** 'off' lets the PC sleep while an agent is working. It's kept awake otherwise. */
  keepAwake?: string
  /** The most agents running at once: a new one past it doesn't start. Blank means no limit. */
  agentLimit?: string
  /** 'on' sends "continue" once to an agent still stopped at a usage limit when it resets. Off otherwise. */
  continueAtReset?: string
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
