import { contextBridge, ipcRenderer } from 'electron'
import type { WorkBridge } from '../shared/git'

/** Every method is one request on the channel `pb:work:<method>`, served in src/main/workIpc.ts. */
const call =
  (name: string) =>
  (...args: unknown[]): Promise<never> =>
    ipcRenderer.invoke(`pb:work:${name}`, ...args) as Promise<never>

const names: (keyof WorkBridge)[] = [
  'gitRepos', 'gitStatus', 'gitDiff', 'gitStage', 'gitUnstage', 'gitDiscard', 'gitCommit', 'gitBranches', 'gitSwitch',
  'gitCreateBranch', 'gitPush', 'gitPull', 'gitFetch', 'gitLog', 'githubRepo', 'githubIssues', 'githubIssueAction',
  'startIssueAgent', 'openGithubPage'
]

export const workBridge = Object.fromEntries(names.map((n) => [n, call(n)])) as unknown as WorkBridge

export function exposeWork(): void {
  contextBridge.exposeInMainWorld('patchbayWork', workBridge)
}
