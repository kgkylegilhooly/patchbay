import { basename, isAbsolute, resolve, sep } from 'node:path'
import type { LaunchConfigItem, LaunchItem, LaunchPlan } from '../../shared/launch'

/**
 * Reads .vscode/launch.json. Reading only describes: nothing here runs anything. A configuration is offered only when
 * Patchbay can run it as written without a debugger. Anything else is listed with the reason it can't be, rather than
 * run some other way.
 */

export type { LaunchCompoundItem, LaunchConfigItem, LaunchItem, LaunchPlan } from '../../shared/launch'

export interface LaunchContext {
  folder: string
  env: Record<string, string | undefined>
  home: string
}

export type LaunchRead = { ok: true; items: LaunchItem[] } | { ok: false; reason: string }

/** JSON with comments and trailing commas, as VS Code writes it. */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) throw new SyntaxError('A /* comment is never closed.')
      // Kept as a space, so the comment can't join two tokens together.
      out += ' '
      i = end + 2
    } else {
      out += c
      i++
    }
  }
  return JSON.parse(withoutTrailingCommas(out.replace(/^﻿/, '')))
}

/** Drops a comma that has only space before a closing bracket, stepping over strings so none inside them is touched. */
function withoutTrailingCommas(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') {
        i++
        continue
      }
    }
    out += c
    i++
  }
  return out
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Fields a debugger uses that change nothing about the program run. */
const DEBUGGER_ONLY = new Set([
  'skipFiles', 'outFiles', 'sourceMaps', 'smartStep', 'stopOnEntry', 'trace', 'resolveSourceMapLocations', 'showAsyncStacks',
  'autoAttachChildProcesses', 'internalConsoleOptions', 'console', 'outputCapture', 'timeout', 'sourceMapPathOverrides',
  'pauseForSourceMap', 'presentation', 'cascadeTerminateToConfigurations', 'sourceMapRenames', 'enableContentValidation',
  'killBehavior', 'customDescriptionGenerator', 'customPropertiesGenerator', 'resolveSourceMapLocations', 'localRoot', 'remoteRoot'
])
const RUN_FIELDS = new Set(['type', 'request', 'name', 'program', 'args', 'cwd', 'env', 'runtimeExecutable', 'runtimeArgs', 'windows', 'osx', 'linux'])
const WHY_NOT: Record<string, string> = {
  preLaunchTask: 'It has a preLaunchTask, and Patchbay doesn\'t run VS Code tasks, so it would start without it.',
  postDebugTask: 'It has a postDebugTask, which Patchbay doesn\'t run.',
  envFile: 'It reads variables from an envFile, which Patchbay doesn\'t read yet.',
  runtimeVersion: 'It asks for a runtimeVersion, which needs a Node version manager.',
  serverReadyAction: 'It has a serverReadyAction, which only VS Code can do.',
  restart: 'It asks to restart itself, which only the debugger does.',
  port: 'It names a debug port, so it expects a debugger to attach.',
  address: 'It names a debug address, so it expects a debugger to attach.'
}

class LaunchProblem extends Error {}

/** ${workspaceFolder} and the other variables that mean the same outside an editor. */
export function substitute(text: string, ctx: LaunchContext): string {
  return text.replace(/\$\{([^}]*)\}/g, (_m, name: string) => {
    if (name === 'workspaceFolder' || name === 'workspaceRoot' || name === 'cwd') return ctx.folder
    if (name === 'workspaceFolderBasename') return basename(ctx.folder)
    if (name === 'userHome') return ctx.home
    if (name === 'pathSeparator' || name === '/') return sep
    if (name.startsWith('env:')) return ctx.env[name.slice(4)] ?? ''
    if (/^(file|relativeFile|fileBasename|fileDirname|fileExtname|fileBasenameNoExtension|fileWorkspaceFolder|lineNumber|selectedText|relativeFileDirname|fileDirnameBasename)$/.test(name)) {
      throw new LaunchProblem(`It uses \${${name}}, which means the file open in an editor. There isn't one here.`)
    }
    if (name.startsWith('input:')) throw new LaunchProblem(`It asks for \${${name}}, an input VS Code would prompt for.`)
    if (name.startsWith('command:')) throw new LaunchProblem(`It runs \${${name}}, a VS Code command.`)
    if (name.startsWith('config:')) throw new LaunchProblem(`It reads \${${name}}, a VS Code setting.`)
    if (name.startsWith('workspaceFolder:')) throw new LaunchProblem(`It names another workspace folder, \${${name}}.`)
    throw new LaunchProblem(`It uses \${${name}}, which Patchbay doesn't know.`)
  })
}

const strings = (v: unknown, field: string): string[] => {
  if (v === undefined) return []
  if (typeof v === 'string') throw new LaunchProblem(`Its ${field} is one string, which VS Code splits the way a shell would. Write it as a list.`)
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) throw new LaunchProblem(`Its ${field} must be a list of strings.`)
  return v as string[]
}

function planConfig(raw: Record<string, unknown>, ctx: LaunchContext): { plan: LaunchPlan; notes: string[] } {
  // VS Code applies the windows section over the rest on this PC.
  const own = isObject(raw.windows) ? { ...raw, ...raw.windows, env: { ...(isObject(raw.env) ? raw.env : {}), ...(isObject(raw.windows.env) ? raw.windows.env : {}) } } : raw
  if (own.type !== 'node' && own.type !== 'pwa-node') throw new LaunchProblem(`It's a "${String(own.type)}" configuration. Only node ones can run without a debugger.`)
  if (own.request !== 'launch') throw new LaunchProblem(own.request === 'attach' ? 'It attaches a debugger to something already running.' : 'Its request must be "launch".')
  const notes: string[] = []
  for (const key of Object.keys(own)) {
    if (WHY_NOT[key]) throw new LaunchProblem(WHY_NOT[key])
    if (DEBUGGER_ONLY.has(key)) notes.push(key)
    else if (!RUN_FIELDS.has(key)) throw new LaunchProblem(`It has "${key}", which Patchbay can't honor, so it might run differently.`)
  }
  const text = (v: unknown, field: string): string | undefined => {
    if (v === undefined) return undefined
    if (typeof v !== 'string') throw new LaunchProblem(`Its ${field} must be a string.`)
    return substitute(v, ctx)
  }
  const program = text(own.program, 'program')
  const runtime = text(own.runtimeExecutable, 'runtimeExecutable')
  if (!program && !runtime) throw new LaunchProblem('It has no program or runtimeExecutable to run.')
  const cwdText = text(own.cwd, 'cwd') ?? ctx.folder
  const cwd = isAbsolute(cwdText) ? cwdText : resolve(ctx.folder, cwdText)
  const env: Record<string, string | null> = {}
  if (own.env !== undefined) {
    if (!isObject(own.env)) throw new LaunchProblem('Its env must be an object.')
    for (const [k, v] of Object.entries(own.env)) {
      if (v !== null && typeof v !== 'string') throw new LaunchProblem(`Its env value for ${k} must be a string or null.`)
      env[k] = v === null ? null : substitute(v, ctx)
    }
  }
  const args = [...strings(own.runtimeArgs, 'runtimeArgs').map((a) => substitute(a, ctx)), ...(program ? [program] : []), ...strings(own.args, 'args').map((a) => substitute(a, ctx))]
  return { plan: { file: runtime ?? 'node', args, cwd, env }, notes }
}

/** How a plan reads as a command line, for showing before it runs. */
export function describePlan(plan: LaunchPlan): string {
  const quote = (s: string) => (/[\s"]/.test(s) || !s ? `"${s.replace(/"/g, '\\"')}"` : s)
  return [plan.file, ...plan.args].map(quote).join(' ')
}

export function readLaunchItems(text: string, ctx: LaunchContext): LaunchRead {
  let root: unknown
  try {
    root = parseJsonc(text)
  } catch (e) {
    return { ok: false, reason: `launch.json isn't valid JSON: ${(e as Error).message}` }
  }
  if (!isObject(root)) return { ok: false, reason: 'launch.json should hold an object.' }
  const configs = Array.isArray(root.configurations) ? root.configurations : []
  const items: LaunchItem[] = []
  const byName = new Map<string, LaunchConfigItem>()
  for (const raw of configs) {
    if (!isObject(raw) || typeof raw.name !== 'string' || !raw.name) continue
    let item: LaunchConfigItem
    try {
      item = { kind: 'config', name: raw.name, ...planConfig(raw, ctx) }
    } catch (e) {
      if (!(e instanceof LaunchProblem)) throw e
      item = { kind: 'config', name: raw.name, problem: e.message, notes: [] }
    }
    if (byName.has(item.name)) item = { kind: 'config', name: item.name, problem: 'Another configuration has the same name.', notes: [] }
    else byName.set(item.name, item)
    items.push(item)
  }
  for (const raw of Array.isArray(root.compounds) ? root.compounds : []) {
    if (!isObject(raw) || typeof raw.name !== 'string' || !raw.name) continue
    const list = Array.isArray(raw.configurations) ? raw.configurations : []
    const members = list.map((m) => (typeof m === 'string' ? m : isObject(m) && typeof m.name === 'string' ? m.name : '?'))
    const notes = raw.stopAll ? ['stopAll: each one has its own Stop here'] : []
    const problem = ((): string | undefined => {
      if (raw.preLaunchTask) return WHY_NOT.preLaunchTask
      if (!members.length) return 'It lists no configurations.'
      if (list.some((m) => typeof m !== 'string')) return 'It names a configuration in another workspace folder.'
      for (const name of members) {
        const member = byName.get(name)
        if (!member) return `It names "${name}", which isn't in this launch.json.`
        if (member.problem) return `"${name}" can't run here: ${member.problem}`
      }
      return undefined
    })()
    items.push({ kind: 'compound', name: raw.name, members, notes, ...(problem && { problem }) })
  }
  return { ok: true, items }
}
