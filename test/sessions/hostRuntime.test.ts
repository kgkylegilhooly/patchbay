import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { HOST_EXE, hostRuntime, pruneHostRuntimes } from '../../src/main/sessions/hostSpawn'
import { removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

let root: string
let install: string
let base: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pb-host-runtime '))
  install = join(root, 'Programs', 'patchbay')
  base = join(root, 'host-runtime')
  const files: Record<string, string> = {
    'Patchbay.exe': 'program',
    'ffmpeg.dll': 'needed',
    'icudtl.dat': 'needed',
    'LICENSE.electron.txt': 'window only',
    'dxcompiler.dll': 'window only',
    'resources.pak': 'window only',
    'chrome_100_percent.pak': 'window only',
    'Uninstall Patchbay.exe': 'window only',
    'locales/en-US.pak': 'window only',
    'resources/app.asar': 'app v1',
    'resources/app.asar.unpacked/node_modules/node-pty/LICENSE': 'nested, so kept',
    'resources/app.asar.unpacked/node_modules/node-pty/build/pty.node': 'native'
  }
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(install, file, '..'), { recursive: true })
    writeFileSync(join(install, file), text)
  }
})

afterEach(() => removeTemp(root))

const mainDir = (): string => join(install, 'resources', 'app.asar', 'out', 'main')

test('the host gets a copy outside the install folder, with its program renamed and the window-only files left out', async () => {
  const runtime = await hostRuntime({ installDir: install, baseDir: base, version: '0.1.0', mainDir: mainDir() })
  expect(runtime).not.toBeNull()
  const dir = join(runtime!.exe, '..')
  expect(dir.startsWith(base)).toBe(true)
  expect(runtime!.exe.endsWith(HOST_EXE)).toBe(true)
  expect(readFileSync(runtime!.exe, 'utf8')).toBe('program')
  expect(runtime!.mainDir).toBe(join(dir, 'resources', 'app.asar', 'out', 'main'))
  for (const kept of ['ffmpeg.dll', 'icudtl.dat', 'resources/app.asar', 'resources/app.asar.unpacked/node_modules/node-pty/LICENSE', 'resources/app.asar.unpacked/node_modules/node-pty/build/pty.node']) {
    expect(existsSync(join(dir, kept)), kept).toBe(true)
  }
  for (const left of ['Patchbay.exe', 'LICENSE.electron.txt', 'dxcompiler.dll', 'resources.pak', 'chrome_100_percent.pak', 'Uninstall Patchbay.exe', 'locales']) {
    expect(existsSync(join(dir, left)), left).toBe(false)
  }
})

test('it is made once per build: the same build reuses it, and a new one, even with the same version, gets its own', async () => {
  const first = await hostRuntime({ installDir: install, baseDir: base, version: '0.1.0', mainDir: mainDir() })
  const madeAt = statSync(first!.exe).mtimeMs
  const again = await hostRuntime({ installDir: install, baseDir: base, version: '0.1.0', mainDir: mainDir() })
  expect(again!.exe).toBe(first!.exe)
  expect(statSync(again!.exe).mtimeMs).toBe(madeAt)
  writeFileSync(join(install, 'resources', 'app.asar'), 'app v2, a new build')
  const later = Date.now() / 1000 + 5
  utimesSync(join(install, 'resources', 'app.asar'), later, later)
  const next = await hostRuntime({ installDir: install, baseDir: base, version: '0.1.0', mainDir: mainDir() })
  expect(next!.exe).not.toBe(first!.exe)
  expect(readFileSync(join(next!.exe, '..', 'resources', 'app.asar'), 'utf8')).toBe('app v2, a new build')
})

test('a copy that could not be made gives null, so the host runs from the install folder', async () => {
  rmSync(join(install, 'Patchbay.exe'))
  expect(await hostRuntime({ installDir: install, baseDir: base, version: '0.1.0', mainDir: mainDir() })).toBeNull()
})

test('copies no host runs from are removed, and one a host is running from is left whole', async () => {
  const current = await hostRuntime({ installDir: install, baseDir: base, version: '0.1.0', mainDir: mainDir() })
  const old = join(base, 'old-build')
  const running = join(base, 'running-build')
  for (const dir of [old, running]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(old, HOST_EXE), 'stale')
  // A real program running from its copy, as a host from an older build would be.
  copyFileSync(process.execPath, join(running, HOST_EXE))
  const child = spawn(join(running, HOST_EXE), ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 500))
  try {
    await pruneHostRuntimes(base, join(current!.exe, '..'))
    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(running, HOST_EXE))).toBe(true)
    expect(existsSync(current!.exe)).toBe(true)
  } finally {
    child.kill()
    await new Promise((r) => child.once('exit', r))
  }
  await pruneHostRuntimes(base, join(current!.exe, '..'))
  expect(existsSync(running)).toBe(false)
})
