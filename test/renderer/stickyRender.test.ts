import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { build } from 'vite'
import { renderMarkdown } from '../../src/renderer/stickyRender'

const CASES = {
  script: '# Title\n\n<script>window.pwned = 1</script>after',
  handler: '<img src="x.png" onerror="window.pwned = 1"> <a href="#" onclick="window.pwned = 1">go</a>',
  jsLink: '[click](javascript:window.pwned=1)',
  iframe: '<iframe src="https://example.com"></iframe>text',
  style: '<p style="position:fixed">x</p><style>body{display:none}</style>',
  normal: '**bold** and `code`\n\n- one\n- [x] two\n\n[site](https://example.com)',
  code: '```json\n{ "a": 1, "b": true }\n```',
  evilCode: '```"><img src=x onerror=window.pwned=1>\n</code></pre><script>window.pwned=1</script>\n```',
  tasks: '- [ ] one\n- [x] two'
}

// DOMPurify does nothing without a DOM, so its real behavior is only proven in a real one.
// The repo has no jsdom, so this runs the real module inside a hidden Electron page.
describe('in a real DOM', () => {
  let dir: string
  let results: Record<string, string> & { pwned: string }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'patchbay-sticky-'))
    const root = resolve(__dirname, '../..')
    const out = await build({
      configFile: false,
      logLevel: 'silent',
      root,
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        write: false,
        minify: false,
        lib: { entry: resolve(root, 'src/renderer/stickyRender.ts'), formats: ['iife'], name: 'Sticky', fileName: () => 'sticky.js' }
      }
    })
    const code = (Array.isArray(out) ? out[0] : (out as { output: { code?: string }[] })).output[0].code ?? ''
    const bundle = join(dir, 'sticky.js')
    writeFileSync(bundle, code)
    const main = join(dir, 'main.cjs')
    const resultFile = join(dir, 'result.json')
    writeFileSync(
      main,
      `const { app, BrowserWindow } = require('electron')
const fs = require('fs')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('about:blank')
  await win.webContents.executeJavaScript(fs.readFileSync(${JSON.stringify(bundle)}, 'utf8') + ';0')
  const cases = ${JSON.stringify(CASES)}
  const r = await win.webContents.executeJavaScript(\`(async () => {
    const cases = \${JSON.stringify(cases)}
    const out = {}
    for (const k of Object.keys(cases)) {
      out[k] = Sticky.renderMarkdown(cases[k], { tasks: k === 'tasks' })
      const holder = document.createElement('div')
      holder.innerHTML = out[k]
      document.body.appendChild(holder)
    }
    await new Promise((r) => setTimeout(r, 100))
    out.pwned = String(window.pwned)
    return out
  })()\`)
  fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(r))
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const require = createRequire(import.meta.url)
    const electron = require('electron') as unknown as string
    const run = spawnSync(electron, [main, `--user-data-dir=${join(dir, 'profile')}`], {
      env,
      encoding: 'utf8',
      timeout: 60000
    })
    if (run.status !== 0) throw new Error(`Electron failed: ${run.stderr}`)
    const { readFileSync } = await import('node:fs')
    results = JSON.parse(readFileSync(resultFile, 'utf8'))
  }, 120000)

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('sticky markdown strips script tags and event handlers', () => {
    expect(results.script).toContain('<h1>')
    expect(results.script).not.toMatch(/<script/i)
    expect(results.handler).not.toMatch(/onerror|onclick/i)
    expect(results.pwned).toBe('undefined')
  })

  test('javascript links, frames and styles do not survive', () => {
    expect(results.jsLink).not.toMatch(/javascript:/i)
    expect(results.iframe).not.toMatch(/<iframe/i)
    expect(results.style).not.toMatch(/<style|style=/i)
  })

  test('ordinary markdown still renders', () => {
    expect(results.normal).toContain('<strong>bold</strong>')
    expect(results.normal).toContain('<code>code</code>')
    expect(results.normal).toContain('<li>')
    expect(results.normal).toContain('href="https://example.com"')
  })

  test('fenced code is colored inside a block with its language and a copy control', () => {
    expect(results.code).toContain('class="code-block"')
    expect(results.code).toContain('<span class="code-lang">JSON</span>')
    expect(results.code).toContain('class="code-copy"')
    expect(results.code).toContain('<span class="tok-key">"a"</span>')
    expect(results.code).toContain('<span class="tok-literal">true</span>')
  })

  test('hostile code and language names stay text', () => {
    expect(results.evilCode).not.toMatch(/<img|<script|onerror/i)
  })

  test('task boxes are numbered, and only clickable where asked', () => {
    expect(results.tasks).toContain('data-task="0"')
    expect(results.tasks).toContain('data-task="1"')
    expect(results.tasks).not.toContain('disabled')
    expect(results.normal).toContain('disabled')
  })
})

test('without a DOM it fails closed: everything comes back as escaped text', () => {
  const html = renderMarkdown('<script>x</script><img src=x onerror=y>')
  expect(html).not.toContain('<script')
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;script&gt;')
})
