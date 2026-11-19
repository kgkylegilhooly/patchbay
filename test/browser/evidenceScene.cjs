'use strict'
// Real CLI + guest + evidence UI, used by node screenshot.js --scene browser-evidence.
// No real agent, external website or personal profile.
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const L = require('../acceptance/lib.cjs')

function seed(doc) {
  const cwd = doc.projects[0].folder
  doc.nodes = [
    { id: 'evidence-agent', kind: 'terminal', title: 'Verification shell', x: 2000, y: 0, width: 520, height: 300, parentId: null, cwd, projectId: 'p1' },
    { id: 'evidence-page', kind: 'browser', title: 'Checkout · browser verification', x: 10, y: 10, width: 1100, height: 960, parentId: null, url: 'about:blank', openedBy: 'evidence-agent', projectId: 'p1' }
  ]
  doc.edges = [{ id: 'browser-owner', from: 'evidence-agent', to: 'evidence-page', kind: 'opened' }]
  doc.viewport = { x: 20, y: 10, zoom: 1 }
  doc.projects[0].viewport = doc.viewport
  // A P1 task for the check to be evidence for: --task-id has to name a real one.
  doc.projects[0].tasks = {
    tasks: [{
      id: 'checkout-check', projectId: doc.projects[0].id, brief: 'Checkout saves the order', acceptanceCriteria: ['Place order saves it'],
      assignedSessionIds: [], cwd, state: 'running', requiredChecks: [], dependsOn: [], createdAt: Date.now(), updatedAt: Date.now(), acceptances: []
    }],
    attempts: []
  }
  doc.closed = []
}

async function act(page) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/failed')) { res.writeHead(503); res.end('Unavailable'); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      body { margin:0; padding:40px; color:#202c40; background:#eff3f7; font:16px system-ui; }
      main { max-width:640px; margin:auto; padding:26px; background:white; border-radius:14px; }
      h1 { font-size:28px; } button { background:#2759d8; color:white; padding:12px 20px; border:0; border-radius:6px; }
      #result { padding:15px 0; } small { color:#60708a; } input { display:block; margin:10px 0; }
      </style></head><body><main><small>PATCHBAY / LOCAL CHECKOUT FIXTURE</small><h1>Review your order</h1>
      <p>Canvas notebook <strong>£24.00</strong></p><input type="password" value="PASSWORD-SENTINEL">
      <button onclick="document.getElementById('result').textContent='Order saved locally. Receipt service unavailable.'; console.error('password=CONSOLE-SECRET'); fetch('/failed?token=NETWORK-SECRET')">Place order</button>
      <p id="result">Ready to place your order.</p></main></body></html>`)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  let seq = 0
  const cwd = (await L.doc(page)).projects[0].folder
  const run = async args => {
    const out = path.join(cwd, `evidence-${++seq}`).replace(/\\/g, '/')
    await L.submit(page, 'evidence-agent', `patchbay browser ${args} --node evidence-page > ${out}.txt 2>&1; echo $? > ${out}.code`)
    await L.waitFor('browser evidence command', () => fs.existsSync(`${out}.code`) && fs.readFileSync(`${out}.code`, 'utf8').trim(), 45000, 100)
    return { code: Number(fs.readFileSync(`${out}.code`, 'utf8').trim()), text: fs.readFileSync(`${out}.txt`, 'utf8') }
  }
  const cli = async args => {
    const { code, text } = await run(args)
    assert.equal(code, 0, text)
    return JSON.parse(text)
  }
  try {
    await page.evaluate(() => document.querySelector('[data-cmd="toggle-sidebar"]')?.click())
    await L.waitFor('test shell', async () => /\$/.test(await L.snapshot(page, 'evidence-agent')), 30000)
    await cli(`navigate --url http://127.0.0.1:${server.address().port}/checkout`)
    const desktop = await cli('viewport --preset desktop')
    assert.equal(desktop.observed.width, 1280)
    assert.equal(desktop.observed.height, 800)
    const mobile = await cli('viewport --preset mobile')
    assert.equal(mobile.observed.width, 390)
    assert.equal(mobile.observed.height, 844)
    const typo = await run('verify --phase start --task-id checkout-chek')
    assert.notEqual(typo.code, 0, typo.text)
    assert.match(typo.text, /no task "checkout-chek"/)
    await cli('verify --phase start --task-id checkout-check')
    const read = await cli('read')
    const ref = read.elements.find(e => e.name.includes('Place order')).ref
    await cli(`click --ref ${ref}`)
    await cli('verify --phase step')
    const done = await cli('verify --phase finish --outcome failed')
    const attempt = done.observed.attempt
    assert.equal(attempt.assertion, 'failed')
    assert.equal(attempt.captures.length, 3)
    assert(attempt.captures.every(c => c.state === 'available' && c.at > 0 && c.viewport.width === 390 && c.viewport.height === 844 && c.width === 390 && c.height === 844), JSON.stringify(attempt.captures))
    assert(attempt.diagnostics.some(d => d.kind === 'console' && d.attemptId === attempt.id))
    assert(attempt.diagnostics.some(d => d.kind === 'network' && d.status === 503 && d.attemptId === attempt.id))
    assert(!JSON.stringify(attempt).includes('SECRET'))
    assert.equal(attempt.startedBy.id, 'evidence-agent')
    assert(attempt.captures.every(c => c.masked === true), 'evidence pictures say fields were hidden')
    // Finish gave the page back its own size: no longer the mobile preset's 844.
    const after = await cli('scroll --to top')
    assert.notEqual(after.viewportHeight ?? after.observed?.viewportHeight, 844, JSON.stringify(after))
    // The task lists the attempt, as the agent's claim.
    await L.waitFor('task lists the browser check', async () => {
      const records = (await L.doc(page)).projects[0].tasks
      const link = records?.attempts.find(a => a.kind === 'browser' && a.browserAttemptId === attempt.id)
      return link && link.assertion === 'failed' && link.state !== 'recording'
    }, 10000)
    await page.click('[data-browser-evidence] > summary')
    await page.waitForSelector('.evidence-pictures img')
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('.browser-attempt > details')].find(d => d.textContent.includes('Observed diagnostics'))
      if (el) el.open = true
    })
    // Give the evidence room in the requested screenshot while leaving the page visible below.
    await page.addStyleTag({ content: '.browser-evidence-content { max-height: 680px }' })
    console.log(`Browser evidence acceptance passed: ${attempt.id}, desktop/mobile, 3 captures, console + HTTP failure, privacy, rendered images.`)
  } finally { await new Promise(r => server.close(r)) }
}
module.exports = { seed, act }
