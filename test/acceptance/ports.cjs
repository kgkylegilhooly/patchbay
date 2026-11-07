'use strict'
// Open ports end to end. Nothing here opens the owner's browser: it only checks that main refuses what it should.
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const lib = require('./lib.cjs')

const { check, finish } = lib.checker()
const shots = process.env.SHOTS

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

async function main() {
  const hash = lib.settingsHash()
  const profile = lib.newProfile()
  const cwd = lib.workDir('ports')
  const [terminalPort, runPort] = [await freePort(), await freePort()]
  fs.writeFileSync(path.join(cwd, 'server.cjs'), `require('http').createServer((q,s)=>s.end('ok')).listen(+process.argv[2],'127.0.0.1')`)
  // Held by this script, outside Patchbay, so it must never be listed.
  const outside = http.createServer((q, s) => s.end('ok'))
  await new Promise((r) => outside.listen(0, '127.0.0.1', r))
  const outsidePort = outside.address().port

  const exe = process.argv.includes('--packaged') ? lib.packagedExe : undefined
  const app = await lib.launch({ profile, exe })
  const { page } = app
  const ports = () => page.evaluate(() => window.patchbay.getPorts())
  const chipsOn = (selector) => page.$$eval(`${selector} .port-chip`, (c) => c.map((e) => e.textContent))
  const listed = (id, port) => lib.waitFor(`:${port} to show`, async () => ((await ports())[id] ?? []).some((p) => p.port === port), 20000)

  try {
    await lib.openNode(page, lib.terminal('shell', cwd, 40, 40))
    await lib.sleep(1500)
    await lib.input(page, 'shell', `node server.cjs ${terminalPort}\r`)
    const started = Date.now()
    await listed('shell', terminalPort)
    check('A server in a plain terminal shows within 10 seconds', Date.now() - started < 10000, `${Date.now() - started} ms`)
    await lib.sleep(300)
    check('Its chip is on the sidebar row', (await chipsOn('.sidebar')).includes(`:${terminalPort}`), await chipsOn('.sidebar'))

    await lib.openNode(page, { id: 'runner', kind: 'run', title: 'runner', x: 660, y: 40, width: 560, height: 300, parentId: null, cwd, command: `node server.cjs ${runPort}` })
    await listed('runner', runPort)
    await lib.sleep(300)
    check('A server in a run node shows on its row', (await chipsOn('.sidebar')).includes(`:${runPort}`))
    check('And in its header', (await chipsOn('.react-flow__node[data-id="runner"]')).includes(`:${runPort}`))
    await lib.fitView(page)
    if (shots) await page.screenshot({ path: path.join(shots, 'ports.png') })

    const all = JSON.stringify(await ports())
    check('A port held outside Patchbay is never listed', !all.includes(`${outsidePort}`), all)
    const name = (await ports()).runner.find((p) => p.port === runPort).name
    check('It knows the process', name === 'node', name)

    const refused = await page.evaluate((p) => window.patchbay.openPort('runner', p), outsidePort)
    check('Opening a port not listed for that window is refused', refused === false, refused)
    const foreign = await page.evaluate((p) => window.patchbay.openPort('shell', p), runPort)
    check("Opening another window's port is refused", foreign === false, foreign)

    await (await page.$('.react-flow__node[data-id="runner"] [data-run="stop"]')).click()
    await lib.waitFor('the chip to go', async () => !((await ports()).runner ?? []).length, 15000)
    check('Stopping it removes the chip', true)
    check('The other server stays', ((await ports()).shell ?? []).some((p) => p.port === terminalPort))

    const free = (port) =>
      new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1')
        socket.on('connect', () => {
          socket.destroy()
          resolve(false)
        })
        socket.on('error', () => resolve(true))
      })
    await page.evaluate(() => window.patchbay.dispatch({ op: 'removeNodes', ids: ['shell'] }))
    await lib.waitFor('the port to free', () => free(terminalPort), 8000).then(
      () => check('Closing a terminal window stops the server in it', true),
      (e) => check('Closing a terminal window stops the server in it', false, e.message)
    )

    // A real npm script, which Git Bash starts through sh, breaking the parent chain.
    const npmPort = await freePort()
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { dev: `node server.cjs ${npmPort}` } }))
    await lib.openNode(page, lib.terminal('npmshell', cwd, 40, 40))
    await lib.sleep(1500)
    await lib.input(page, 'npmshell', 'npm run dev\r')
    await listed('npmshell', npmPort)
    check('A real npm run dev in a terminal shows on its row', true)
    await page.evaluate(() => window.patchbay.dispatch({ op: 'removeNodes', ids: ['npmshell'] }))
    await lib.waitFor('its port to free', () => free(npmPort), 8000).then(
      () => check('Closing the terminal stops npm run dev', true),
      (e) => check('Closing the terminal stops npm run dev', false, e.message)
    )

    const lastPort = await freePort()
    await lib.openNode(page, lib.terminal('last', cwd, 40, 40))
    await lib.sleep(1500)
    await lib.input(page, 'last', `node server.cjs ${lastPort}\r`)
    await listed('last', lastPort)
    check('No errors in the page', app.problems.length === 0, app.problems)
    check('~/.claude/settings.json is unchanged', lib.settingsHash() === hash)
    check('Stop all sessions and quit exits', (await app.quit()) === 0)
    await lib.waitFor('the port to free after quitting', () => free(lastPort), 8000).then(
      () => check('Stopping all sessions stops the server in a terminal', true),
      (e) => check('Stopping all sessions stops the server in a terminal', false, e.message)
    )
  } finally {
    outside.close()
    await app.forceKill().catch(() => {})
    lib.cleanup(profile)
  }
  finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
