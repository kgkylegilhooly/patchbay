#!/usr/bin/env node
// Usage: node screenshot.js <out.png> [--wait <ms>] [--no-build] [--scene <name>] [--size <width>x<height>]
//
// Builds the app, launches Electron with a remote debugging port and a throwaway
// profile, connects Puppeteer, writes a PNG of the app window, then stops only the
// Electron process it started. The throwaway profile keeps it away from real app
// data and lets it run while another Patchbay is open.
//
// --scene opens a canvas from test/acceptance/scenes.cjs and sets it up before the picture.
// --size draws the page at that size, for checking narrow layouts.
const { spawn, spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:net')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const puppeteer = require('puppeteer-core')

const root = __dirname

function parseArgs(argv) {
  const opts = { out: null, wait: 1500, build: true, scene: null, size: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--wait') opts.wait = Number(argv[++i])
    else if (argv[i] === '--no-build') opts.build = false
    else if (argv[i] === '--scene') opts.scene = argv[++i]
    else if (argv[i] === '--size') {
      const [width, height] = String(argv[++i]).split('x').map(Number)
      if (!width || !height) throw new Error('--size needs <width>x<height>')
      opts.size = { width, height }
    } else if (!opts.out) opts.out = argv[i]
    else throw new Error(`Unexpected argument: ${argv[i]}`)
  }
  if (!opts.out) throw new Error('Usage: node screenshot.js <out.png> [--wait <ms>] [--no-build]')
  if (!Number.isFinite(opts.wait) || opts.wait < 0) throw new Error('--wait needs a number of milliseconds')
  return opts
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

function build() {
  const bin = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  const r = spawnSync(process.execPath, [bin, 'build'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`Build failed:\n${r.stdout}\n${r.stderr}`)
}

async function connect(port, deadline) {
  let lastError
  while (Date.now() < deadline) {
    try {
      return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
    } catch (e) {
      lastError = e
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error(`Could not connect to Electron: ${lastError && lastError.message}`)
}

async function appPage(browser, deadline) {
  while (Date.now() < deadline) {
    const pages = await browser.pages()
    const page = pages.find((p) => !p.url().startsWith('devtools://') && p.url() !== 'about:blank')
    if (page) return page
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('The app window never appeared')
}

function stop(child) {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill()
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const out = resolve(opts.out)
  if (opts.build) build()
  if (!existsSync(join(root, 'out', 'main', 'index.js'))) throw new Error('out/main/index.js is missing; run without --no-build')

  const electronPath = require('electron')
  const port = await freePort()
  const profile = mkdtempSync(join(tmpdir(), 'patchbay-shot-'))
  const scene = opts.scene ? require('./test/acceptance/scenes.cjs').prepare(opts.scene) : null
  if (scene) {
    writeFileSync(join(profile, 'canvas.json'), JSON.stringify(scene.doc))
    writeFileSync(join(profile, 'settings.json'), JSON.stringify(scene.settings))
  }
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    // This may run from inside another agent's session, which must not be mistaken for one of Patchbay's.
    if (!require('./test/acceptance/lib.cjs').inheritNot(key) && !/^ELECTRON_RUN_AS_NODE$|^ELECTRON_RENDERER_URL$/i.test(key)) env[key] = value
  }
  // As in the acceptance runs, the window opens beside the screens without taking focus, so pictures don't pop up over
  // whatever the person is doing. PB_SHOW=1 shows it as usual.
  if (!process.env.PB_SHOW) env.PATCHBAY_QUIET_WINDOW = '1'

  const child = spawn(
    electronPath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      // A window behind others draws no frames, which would hang the picture.
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      root
    ],
    { cwd: root, env, stdio: 'ignore' }
  )
  let browser
  try {
    const deadline = Date.now() + 30000
    browser = await connect(port, deadline)
    const page = await appPage(browser, deadline)
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 })
    const cdp = await page.createCDPSession()
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    if (opts.size) await page.setViewport(opts.size)
    await new Promise((r) => setTimeout(r, opts.wait))
    if (scene) {
      await scene.act(page, { profile })
      await new Promise((r) => setTimeout(r, 400))
    }
    mkdirSync(dirname(out), { recursive: true })
    await page.screenshot({ path: out })
    console.log(out)
  } finally {
    if (browser) browser.disconnect()
    stop(child)
    await new Promise((r) => setTimeout(r, 300))
    // Sessions outlive the app, so this throwaway profile's session host has to be ended by name.
    try {
      const { pid } = JSON.parse(readFileSync(join(profile, 'control', 'host.json'), 'utf8'))
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 })
    } catch {
      // It never started, or has already gone.
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    if (scene) rmSync(scene.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
