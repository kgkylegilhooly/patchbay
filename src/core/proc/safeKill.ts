import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Ends process trees on Windows without ever naming a process by a bare PID. See docs/plans/r5-jobkill.md.
 *
 * A PID names a process only while something holds a handle to it. taskkill, node-pty's own kill and process.kill(pid)
 * all open a PID some time after it was found, and Windows hands freed PIDs out again within seconds, so each could end
 * a stranger. Here a helper (Windows PowerShell running a small C# class, both shipped with Windows; one per process,
 * kept while it's used) opens
 * every process first, proves from the kernel's own records, read through that handle, that it is one of ours, and only
 * then ends it through the same handle:
 * - a root: a child of whoever started the helper, created after it, no later than the kill was asked for, and (when
 *   known) no earlier than just before it was started;
 * - a console member: on the (held) root's console when listed, and created before the list was read;
 * - a child: its parent is held, and it was created no earlier than that parent.
 * Anything not proven is left running.
 */

export interface KillRoot {
  pid: number
  /** When the kill was asked for (ms since the epoch). A root created after this has a reused PID. */
  bornBefore: number
  /** Also every process on its console. */
  console?: boolean
  /** Also everything it, and they, started. */
  tree?: boolean
  /** Proven and held, so its console and tree can be found, but left running (a session's shell, closed by node-pty). */
  keep?: boolean
  /** When known: it was started no earlier than this (ms since the epoch), as a session's shell just before pty.spawn. */
  bornAfter?: number
}

export interface KillReport {
  /** Whether the helper ran to the end. When false nothing was killed by it. */
  ok: boolean
  /** Ended by the helper (were running, now terminated). */
  killed: number[]
  /** Proven ours but already ended when reached. */
  gone: number[]
  /** Proven ours and held, but left running as asked (`keep`). */
  kept: number[]
  /** Not proven ours, or not found: left alone. */
  skipped: Array<{ pid: number; why: string }>
  /** What each root's console held when it was read, the helper itself left out. */
  listed: Record<number, number[]>
  error?: string
}

export interface EndTreesOptions {
  /** Tests only: the helper waits this long between reading a console and opening its processes. */
  pauseAfterListMs?: number
  /** Called once a root's console has been read (before the pause). */
  onListed?: (root: number, members: number[]) => void
  /** How the helper is started (tests): a helper of its own, ended after this request. */
  spawn?: typeof nodeSpawn
  limitMs?: number
}

export const SAFE_KILL_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PbSafeKill {
  const uint TERMINATE = 0x0001, QUERY_LIMITED = 0x1000, SYNCHRONIZE = 0x00100000;
  const long EPOCH = 116444736000000000L;
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long create, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out long ft);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList([Out] uint[] list, uint count);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr s, ref Entry e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr s, ref Entry e);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref Basic info, int size, out int ret);

  [StructLayout(LayoutKind.Sequential)]
  struct Basic { public IntPtr ExitStatus; public IntPtr Peb; public IntPtr Affinity; public IntPtr Priority; public IntPtr Pid; public IntPtr Parent; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry {
    public uint dwSize; public uint cntUsage; public uint pid; public IntPtr heap; public uint module; public uint threads;
    public uint parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe;
  }

  class Held { public uint Pid; public IntPtr Handle; public long Created; public uint Parent; public string Why; public bool Keep; }

  static Held Open(uint pid) {
    IntPtr h = OpenProcess(TERMINATE | QUERY_LIMITED | SYNCHRONIZE, false, pid);
    if (h == IntPtr.Zero) return null;
    long c, e, k, u;
    Basic b = new Basic(); int ret;
    if (!GetProcessTimes(h, out c, out e, out k, out u) || NtQueryInformationProcess(h, 0, ref b, Marshal.SizeOf(typeof(Basic)), out ret) != 0) {
      CloseHandle(h);
      return null;
    }
    return new Held { Pid = pid, Handle = h, Created = c, Parent = (uint)b.Parent.ToInt64() };
  }

  static List<Entry> Snapshot() {
    var list = new List<Entry>();
    IntPtr s = CreateToolhelp32Snapshot(2, 0);
    if (s == IntPtr.Zero || s == new IntPtr(-1)) return list;
    Entry e = new Entry(); e.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
    if (Process32FirstW(s, ref e)) { do { list.Add(e); } while (Process32NextW(s, ref e)); }
    CloseHandle(s);
    return list;
  }

  static uint[] ConsoleList(out long listedAt) {
    uint[] buf = new uint[64];
    while (true) {
      GetSystemTimePreciseAsFileTime(out listedAt);
      uint n = GetConsoleProcessList(buf, (uint)buf.Length);
      if (n == 0) return new uint[0];
      if (n <= buf.Length) { var r = new uint[n]; Array.Copy(buf, r, n); return r; }
      buf = new uint[n + 16];
    }
  }

  // Each root: "pid:bornBeforeMs:flags[:bornAfterMs]" (c = its console's processes, t = its tree, k = held and proven
  // but left running, p = it's the parent of whoever started this helper, and that alone). One line out per finding.
  public static string Run(string[] roots, int pauseMs) {
    try { return Roots(roots, pauseMs); } catch (Exception e) { return "error " + e.GetType().Name + "\n"; }
  }

  static string Roots(string[] roots, int pauseMs) {
    var outp = new StringBuilder();
    uint self = GetCurrentProcessId();
    Basic sb = new Basic(); int ret;
    long sc, se, sk, su;
    if (NtQueryInformationProcess(GetCurrentProcess(), 0, ref sb, Marshal.SizeOf(typeof(Basic)), out ret) != 0 || !GetProcessTimes(GetCurrentProcess(), out sc, out se, out sk, out su)) return "error self\n";
    // Whoever started this helper, held, and created before it: its children are the only roots it accepts.
    Held starter = Open((uint)sb.Parent.ToInt64());
    if (starter == null || starter.Created >= sc) return "error starter\n";
    var held = new Dictionary<uint, Held>();
    var tree = new HashSet<uint>();
    foreach (string spec in roots) {
      if (spec.Length == 0) continue;
      string[] p = spec.Split(':');
      uint pid = uint.Parse(p[0]); long before = long.Parse(p[1]); string flags = p.Length > 2 ? p[2] : "";
      long after = p.Length > 3 ? long.Parse(p[3]) : 0;
      if (pid == self || pid == starter.Pid || held.ContainsKey(pid)) { outp.Append("skip " + pid + " self\n"); continue; }
      Held r = Open(pid);
      if (r == null) { outp.Append("skip " + pid + " gone\n"); continue; }
      if (flags.Contains("p")) {
        // The starter's own parent: the process with that PID now, if created before the starter, is the one that started it.
        if (pid != starter.Parent || r.Created >= starter.Created) { outp.Append("skip " + pid + " not-ours\n"); CloseHandle(r.Handle); continue; }
        r.Why = "parent"; held[pid] = r;
        continue;
      }
      long born = (r.Created - EPOCH) / 10000;
      if (r.Parent != starter.Pid || r.Created < starter.Created || born > before || born < after) {
        outp.Append("skip " + pid + " not-ours\n");
        CloseHandle(r.Handle);
        continue;
      }
      r.Why = "root"; r.Keep = flags.Contains("k"); held[pid] = r;
      bool wantTree = flags.Contains("t");
      if (wantTree) tree.Add(pid);
      if (!flags.Contains("c")) continue;
      FreeConsole();
      if (!AttachConsole(pid)) { outp.Append("listed " + pid + "\n"); continue; }
      long listedAt;
      uint[] members = ConsoleList(out listedAt);
      FreeConsole();
      var line = new StringBuilder("listed " + pid);
      foreach (uint m in members) if (m != self) line.Append(" " + m);
      outp.Append(line.ToString() + "\n");
      if (pauseMs > 0) { Console.Out.Write(outp.ToString()); Console.Out.Flush(); outp.Length = 0; Thread.Sleep(pauseMs); }
      foreach (uint m in members) {
        if (m == self || m == starter.Pid || held.ContainsKey(m)) continue;
        Held h = Open(m);
        if (h == null) { outp.Append("skip " + m + " gone\n"); continue; }
        // Created before the list was read and still there: the very process that was listed.
        if (h.Created >= listedAt) { outp.Append("skip " + m + " not-listed\n"); CloseHandle(h.Handle); continue; }
        h.Why = "member"; held[m] = h;
        if (wantTree) tree.Add(m);
      }
    }
    var done = new HashSet<uint>();
    for (int round = 0; round < 3; round++) {
      if (tree.Count > 0) {
        // A child of a held process, created no earlier than it: that process's own, as it has had its PID throughout.
        var snap = Snapshot();
        bool grew = true;
        while (grew) {
          grew = false;
          foreach (var e in snap) {
            if (e.pid == 0 || e.pid == self || e.pid == starter.Pid || held.ContainsKey(e.pid) || !tree.Contains(e.parent)) continue;
            Held h = Open(e.pid);
            if (h == null) continue;
            Held parent;
            if (!tree.Contains(h.Parent) || !held.TryGetValue(h.Parent, out parent) || h.Created < parent.Created) { CloseHandle(h.Handle); continue; }
            h.Why = "child"; held[e.pid] = h; tree.Add(e.pid); grew = true;
          }
        }
      }
      int before = done.Count;
      foreach (var h in held.Values) {
        if (done.Contains(h.Pid)) continue;
        done.Add(h.Pid);
        if (h.Keep) { outp.Append("kept " + h.Pid + "\n"); continue; }
        if (WaitForSingleObject(h.Handle, 0) != 0 && TerminateProcess(h.Handle, 1)) outp.Append("killed " + h.Pid + " " + h.Why + "\n");
        else outp.Append("gone " + h.Pid + " " + h.Why + "\n");
      }
      if (done.Count == before || tree.Count == 0) break;
    }
    foreach (var h in held.Values) CloseHandle(h.Handle);
    CloseHandle(starter.Handle);
    return outp.ToString();
  }
}
`


/**
 * One helper per process, reused: PowerShell's start and the compile (~0.7 s) are paid once, not per kill, and a
 * security product sees one compile, from a readable source file, not one per window closed. It reads one request a
 * line ("pauseMs root root..."), answers with its findings and "done", and ends when its input closes.
 */
const COMMAND =
  "$ErrorActionPreference='Stop'; Add-Type -IgnoreWarnings -Path $env:PB_SAFEKILL_CS; " +
  "[Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); " +
  "while ($null -ne ($l = [Console]::In.ReadLine())) { $w = $l.Split(' '); " +
  "[Console]::Out.Write([PbSafeKill]::Run([string[]]($w | Select-Object -Skip 1), [int]$w[0])); " +
  "[Console]::Out.WriteLine('done'); [Console]::Out.Flush() }"

export const powershellPath = (): string => join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** Reads the helper's output. Exported for tests. */
export function parseReport(text: string, onListed?: (root: number, members: number[]) => void): KillReport {
  const report: KillReport = { ok: false, killed: [], gone: [], kept: [], skipped: [], listed: {} }
  for (const raw of text.split(/\r?\n/)) {
    const [word, ...rest] = raw.trim().split(/\s+/)
    if (word === 'killed' || word === 'gone' || word === 'kept') report[word].push(Number(rest[0]))
    else if (word === 'skip') report.skipped.push({ pid: Number(rest[0]), why: rest[1] ?? '' })
    else if (word === 'listed') {
      const [root, ...members] = rest.map(Number)
      report.listed[root] = members
      onListed?.(root, members)
    } else if (word === 'error') report.error = rest.join(' ') || 'error'
  }
  return report
}

/**
 * Only what Windows and the compiler need. PowerShell creates `%USERPROFILE%\AppData\Local` and `Roaming` when it starts,
 * so with this process's own environment it could bring back a folder that was just deleted (a test profile, a host
 * whose data folder went away). Leaving USERPROFILE out isn't enough, as Node copies it in from this process, so it's the
 * signed-in user's own profile, read from the account, which is there anyway.
 */
function helperEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP']) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  try {
    env.USERPROFILE = userInfo().homedir
  } catch {
    // No account profile to read: Node copies this process's own in.
  }
  return env
}

/** The C# as a plain file in the temp folder, named by its content, written once. */
export function sourceFile(): string {
  const file = join(tmpdir(), 'patchbay-safekill', `PbSafeKill-${createHash('sha256').update(SAFE_KILL_SOURCE).digest('hex').slice(0, 16)}.cs`)
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    const part = `${file}.${process.pid}.tmp`
    writeFileSync(part, SAFE_KILL_SOURCE)
    renameSync(part, file)
  }
  return file
}

/** How to start the helper, for a caller that starts and feeds it itself (the exit guard). */
export function helperCommand(): { file: string; args: string[]; env: Record<string, string> } {
  return { file: powershellPath(), args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', COMMAND], env: { ...helperEnv(), PB_SAFEKILL_CS: sourceFile() } }
}

/** The request that ends the parent of whoever started the helper, if it's still that process (the exit guard). */
export const endParentRequest = (parentPid: number): string => `0 ${parentPid}:0:p`

const spec = (r: KillRoot): string =>
  `${r.pid}:${Math.floor(r.bornBefore)}:${r.console ? 'c' : ''}${r.tree ? 't' : ''}${r.keep ? 'k' : ''}${r.bornAfter ? `:${Math.floor(r.bornAfter)}` : ''}`

interface Request {
  line: string
  out: string
  onListed?: (root: number, members: number[]) => void
  resolve: (report: KillReport) => void
  timer?: NodeJS.Timeout
}

export interface Killer {
  run(roots: KillRoot[], opts?: { pauseAfterListMs?: number; onListed?: (root: number, members: number[]) => void }): Promise<KillReport>
  /** Why the helper can't run in this process, once it's known; then nothing more is asked of it. */
  problem(): string | null
  /** Ends the helper now (tests). */
  close(): void
}

/** Generous: PowerShell's start and the compile take ~0.7 s on a quiet PC and several seconds on a loaded one. */
const LIMIT_MS = 15_000
/** A helper with nothing to do for this long ends; the next kill starts another. */
const IDLE_MS = 60_000

export function createKiller(opts: { spawn?: typeof nodeSpawn; limitMs?: number; idleMs?: number; onProblem?: (why: string) => void } = {}): Killer {
  let child: ChildProcess | null = null
  let ready = false
  let buffer = ''
  let err = ''
  let problem: string | null = null
  let current: Request | null = null
  const queue: Request[] = []
  let idle: NodeJS.Timeout | undefined

  const settle = (req: Request, error?: string): void => {
    clearTimeout(req.timer)
    const report = parseReport(req.out)
    report.ok = !error && !report.error
    if (error) report.error = error
    req.resolve(report)
  }

  /** Can't run here at all (blocked, missing, refused): said once, and kills fall back from then on. */
  const unavailable = (why: string): void => {
    if (problem) return
    problem = why
    opts.onProblem?.(why)
  }

  const quiet = (yes: boolean): void => {
    // Nothing to do: it mustn't keep this process running. Working: it must, as callers may only be waiting on it.
    for (const h of [child, child?.stdout, child?.stderr, child?.stdin] as Array<{ ref?(): void; unref?(): void } | null | undefined>) yes ? h?.unref?.() : h?.ref?.()
  }

  const ended = (why: string): void => {
    const was = child
    child = null
    if (!was) return
    const wasReady = ready
    ready = false
    if (!wasReady) unavailable(err.trim().split(/\r?\n/)[0] || why)
    const failed = current ? [current, ...queue.splice(0)] : queue.splice(0)
    current = null
    for (const req of failed) settle(req, problem ?? why)
  }

  const start = (): void => {
    try {
      const command = helperCommand()
      const c = (opts.spawn ?? nodeSpawn)(command.file, command.args, { env: command.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      child = c
      ready = false
      buffer = ''
      err = ''
      c.stdout?.on('data', (d: Buffer) => read(d.toString()))
      c.stderr?.on('data', (d: Buffer) => (err += d.toString()))
      c.stdin?.on('error', () => {})
      c.on('error', (e) => child === c && ended(e.message))
      c.on('close', (code) => child === c && ended(`ended with code ${code}`))
    } catch (e) {
      child = null
      unavailable((e as Error).message)
    }
  }

  const read = (text: string): void => {
    buffer += text
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '')
      buffer = buffer.slice(at + 1)
      if (!ready) {
        if (line === 'ready') {
          ready = true
          pump()
        }
        continue
      }
      if (!current) continue
      if (line === 'done') {
        const req = current
        current = null
        settle(req)
        pump()
        continue
      }
      current.out += `${line}\n`
      // Streamed, so a test can act while the helper waits after a list.
      if (current.onListed) parseReport(line, current.onListed)
    }
  }

  const pump = (): void => {
    clearTimeout(idle)
    if (current) return
    const next = queue.shift()
    if (!next) {
      quiet(true)
      idle = setTimeout(() => child?.stdin?.end(), opts.idleMs ?? IDLE_MS)
      idle.unref?.()
      return
    }
    if (problem) return settle(next, problem)
    if (!child) start()
    if (!child) return settle(next, problem ?? 'helper failed')
    quiet(false)
    if (!ready) {
      queue.unshift(next)
      return
    }
    current = next
    child.stdin?.write(`${next.line}\n`)
  }

  return {
    run(asked, runOpts = {}) {
      const roots = merge(asked)
      if (roots.length === 0) return Promise.resolve({ ok: true, killed: [], gone: [], kept: [], skipped: [], listed: {} })
      if (problem) return Promise.resolve({ ok: false, killed: [], gone: [], kept: [], skipped: [], listed: {}, error: problem })
      return new Promise((resolve) => {
        const req: Request = { line: `${runOpts.pauseAfterListMs ?? 0} ${roots.map(spec).join(' ')}`, out: '', onListed: runOpts.onListed, resolve }
        // Its own time, from when it's asked: a first request includes the helper's start.
        req.timer = setTimeout(() => {
          const queued = queue.indexOf(req)
          if (queued >= 0) {
            queue.splice(queued, 1)
            settle(req, 'timed out')
          } else if (current === req) child?.kill()
        }, (opts.limitMs ?? LIMIT_MS) + (runOpts.pauseAfterListMs ?? 0))
        queue.push(req)
        pump()
      })
    },
    problem: () => problem,
    close() {
      clearTimeout(idle)
      child?.stdin?.end()
    }
  }
}

/** The same PID asked for twice keeps the wider ask, the narrowest time window, and is left running only if every ask says so. */
function merge(roots: KillRoot[]): KillRoot[] {
  const byPid = new Map<number, KillRoot>()
  for (const r of roots) {
    if (!Number.isInteger(r.pid) || r.pid <= 0) continue
    const was = byPid.get(r.pid)
    byPid.set(
      r.pid,
      was
        ? {
            pid: r.pid,
            bornBefore: Math.min(was.bornBefore, r.bornBefore),
            bornAfter: Math.max(was.bornAfter ?? 0, r.bornAfter ?? 0) || undefined,
            console: was.console || r.console,
            tree: was.tree || r.tree,
            keep: was.keep && r.keep
          }
        : { ...r }
    )
  }
  return [...byPid.values()]
}

const problemListeners: Array<(why: string) => void> = []
let shared: Killer | null = null
const killer = (): Killer =>
  (shared ??= createKiller({
    onProblem: (why) => {
      for (const cb of problemListeners) cb(why)
    }
  }))

/** How a log line about the helper not running starts, so diagnostics can find it in the host's log. */
export const HELPER_PROBLEM_LOG = 'Safe process ends unavailable, ending by PID as round 4 did:'

/** Called once, the first time the helper turns out not to run in this process (to log it). */
export function onHelperProblem(cb: (why: string) => void): void {
  problemListeners.push(cb)
  const known = shared?.problem()
  if (known) cb(known)
}

/** Why this process can't end processes the safe way, or null while it can (or hasn't had to yet). */
export const helperProblem = (): string | null => shared?.problem() ?? null

/**
 * Roots asked for within this long go in one request: quitting asks for every session, one pipe request each.
 */
const BATCH_MS = 20
let batch: { roots: KillRoot[]; done: Promise<KillReport> } | null = null

/**
 * Ends the roots (and their consoles and trees, as asked) through handles, proving each process ours first. Never
 * rejects; `ok: false` when the helper couldn't do it, and then nothing was killed. Windows only. `spawn` (tests) uses a
 * helper of its own.
 */
export function endTrees(roots: KillRoot[], opts: EndTreesOptions = {}): Promise<KillReport> {
  if (opts.spawn || opts.limitMs) {
    const own = createKiller({ spawn: opts.spawn, limitMs: opts.limitMs })
    return own.run(roots, opts).finally(() => own.close())
  }
  if (opts.pauseAfterListMs || opts.onListed) return killer().run(roots, opts)
  if (!batch) {
    const current: { roots: KillRoot[]; done: Promise<KillReport> } = {
      roots: [],
      done: new Promise<KillReport>((resolve) => {
        setTimeout(() => {
          batch = null
          resolve(killer().run(current.roots))
        }, BATCH_MS)
      })
    }
    batch = current
  }
  batch.roots.push(...roots)
  return batch.done
}
