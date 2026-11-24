import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { userInfo } from 'node:os'
import { join } from 'node:path'

/**
 * Ends process trees on Windows without ever naming a process by a bare PID. See docs/plans/r5-jobkill.md.
 *
 * A PID names a process only while something holds a handle to it. taskkill, node-pty's own kill and process.kill(pid)
 * all open a PID some time after it was found, and Windows hands freed PIDs out again within seconds, so each could end
 * a stranger. Here one short-lived helper (Windows PowerShell running a small C# class, both shipped with Windows) opens
 * every process first, proves from the kernel's own records, read through that handle, that it is one of ours, and only
 * then ends it through the same handle:
 * - a root: a child of whoever started the helper, created after it and no later than the kill was asked for;
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
}

export interface KillReport {
  /** Whether the helper ran to the end. When false nothing was killed by it. */
  ok: boolean
  /** Ended by the helper (were running, now terminated). */
  killed: number[]
  /** Proven ours but already ended when reached. */
  gone: number[]
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
  /** How the helper is started. */
  spawn?: typeof nodeSpawn
  limitMs?: number
}

/** Generous: PowerShell's start and the compile take ~0.7 s on a quiet PC and several seconds on a loaded one. */
const LIMIT_MS = 15_000

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

  class Held { public uint Pid; public IntPtr Handle; public long Created; public uint Parent; public string Why; }

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

  // Each root: "pid:bornBeforeMs:flags" (c = its console's processes, t = its tree, p = it's the parent of whoever
  // started this helper, and that alone). One line out per finding.
  public static string Run(string[] roots, int pauseMs) {
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
      if (pid == self || pid == starter.Pid || held.ContainsKey(pid)) { outp.Append("skip " + pid + " self\n"); continue; }
      Held r = Open(pid);
      if (r == null) { outp.Append("skip " + pid + " gone\n"); continue; }
      if (flags.Contains("p")) {
        // The starter's own parent: the process with that PID now, if created before the starter, is the one that started it.
        if (pid != starter.Parent || r.Created >= starter.Created) { outp.Append("skip " + pid + " not-ours\n"); CloseHandle(r.Handle); continue; }
        r.Why = "parent"; held[pid] = r;
        continue;
      }
      if (r.Parent != starter.Pid || r.Created < starter.Created || (r.Created - EPOCH) / 10000 > before) {
        outp.Append("skip " + pid + " not-ours\n");
        CloseHandle(r.Handle);
        continue;
      }
      r.Why = "root"; held[pid] = r;
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

/** Run as -Command text, which no execution policy applies to; the source and roots come in environment variables. */
const COMMAND =
  "$ErrorActionPreference='Stop'; Add-Type -IgnoreWarnings -TypeDefinition $env:PB_SAFEKILL_SOURCE; " +
  "[Console]::Out.Write([PbSafeKill]::Run(($env:PB_SAFEKILL_ROOTS -split ' '), [int]$env:PB_SAFEKILL_PAUSE_MS))"

export const powershellPath = (): string => join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** Reads the helper's output. Exported for tests. */
export function parseReport(text: string, onListed?: (root: number, members: number[]) => void): KillReport {
  const report: KillReport = { ok: false, killed: [], gone: [], skipped: [], listed: {} }
  for (const raw of text.split(/\r?\n/)) {
    const [word, ...rest] = raw.trim().split(/\s+/)
    if (word === 'killed' || word === 'gone') report[word].push(Number(rest[0]))
    else if (word === 'skip') report.skipped.push({ pid: Number(rest[0]), why: rest[1] ?? '' })
    else if (word === 'listed') {
      const [root, ...members] = rest.map(Number)
      report.listed[root] = members
      onListed?.(root, members)
    } else if (word === 'error') report.error = rest.join(' ')
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

/** How to start the helper for these roots ("pid:bornBeforeMs:flags"), for a caller that starts it itself. */
export function helperCommand(roots: string[], pauseMs = 0): { file: string; args: string[]; env: Record<string, string> } {
  return {
    file: powershellPath(),
    args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', COMMAND],
    env: { ...helperEnv(), PB_SAFEKILL_SOURCE: SAFE_KILL_SOURCE, PB_SAFEKILL_ROOTS: roots.join(' '), PB_SAFEKILL_PAUSE_MS: String(pauseMs) }
  }
}

/**
 * For a process that ends its parent if it's still there later (the app's exit guard): run as that process's own child,
 * the helper ends the given PID only if it's still the process that started the caller.
 */
export const endParentCommand = (parentPid: number): { file: string; args: string[]; env: Record<string, string> } => helperCommand([`${parentPid}:0:p`])

const flags = (r: KillRoot): string => `${r.console ? 'c' : ''}${r.tree ? 't' : ''}`

/**
 * Roots asked for within this long go to one helper: quitting asks for every session, one pipe request each, and the
 * helper's start costs far more than the wait.
 */
const BATCH_MS = 20
let batch: { roots: KillRoot[]; done: Promise<KillReport> } | null = null

/**
 * Ends the roots (and their consoles and trees, as asked) through handles, proving each process ours first. Never
 * rejects; `ok: false` when the helper couldn't run, and then nothing was killed. Windows only.
 */
export function endTrees(roots: KillRoot[], opts: EndTreesOptions = {}): Promise<KillReport> {
  if (opts.pauseAfterListMs || opts.onListed || opts.spawn || opts.limitMs) return runHelper(roots, opts)
  if (!batch) {
    const current: { roots: KillRoot[]; done: Promise<KillReport> } = {
      roots: [],
      done: new Promise<KillReport>((resolve) => {
        setTimeout(() => {
          batch = null
          resolve(runHelper(current.roots, {}))
        }, BATCH_MS)
      })
    }
    batch = current
  }
  batch.roots.push(...roots)
  return batch.done
}

/** The same PID asked for twice keeps the wider ask and the earlier time. */
function merge(roots: KillRoot[]): KillRoot[] {
  const byPid = new Map<number, KillRoot>()
  for (const r of roots) {
    if (!Number.isInteger(r.pid) || r.pid <= 0) continue
    const was = byPid.get(r.pid)
    byPid.set(r.pid, was ? { pid: r.pid, bornBefore: Math.min(was.bornBefore, r.bornBefore), console: was.console || r.console, tree: was.tree || r.tree } : { ...r })
  }
  return [...byPid.values()]
}

function runHelper(asked: KillRoot[], opts: EndTreesOptions): Promise<KillReport> {
  const roots = merge(asked)
  if (roots.length === 0) return Promise.resolve({ ok: true, killed: [], gone: [], skipped: [], listed: {} })
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    let child: ChildProcess
    const finish = (ok: boolean, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const report = parseReport(out)
      report.ok = ok && !report.error
      if (error) report.error = error
      else if (!report.ok && !report.error) report.error = err.trim().split(/\r?\n/)[0] || 'helper failed'
      if (!report.ok) process.stderr.write(`[patchbay] safe kill: ${report.error}\n`)
      resolve(report)
    }
    const timer = setTimeout(() => {
      child?.kill()
      finish(false, 'timed out')
    }, opts.limitMs ?? LIMIT_MS)
    try {
      const command = helperCommand(roots.map((r) => `${r.pid}:${Math.floor(r.bornBefore)}:${flags(r)}`), opts.pauseAfterListMs)
      child = (opts.spawn ?? nodeSpawn)(command.file, command.args, { env: command.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      finish(false, (e as Error).message)
      return
    }
    let seen = ''
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
      if (!opts.onListed) return
      // Streamed, so a test can act while the helper waits after a list.
      const lines = out.slice(seen.length).split('\n')
      lines.pop()
      for (const line of lines) {
        seen += `${line}\n`
        parseReport(line, opts.onListed)
      }
    })
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', (e) => finish(false, e.message))
    child.on('close', (code) => finish(code === 0))
  })
}
