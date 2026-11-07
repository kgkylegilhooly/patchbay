'use strict'
// SSH terminals: the canvas menu's "SSH to host…" lists the hosts in ~/.ssh/config (here a stand-in file given by
// PATCHBAY_SSH_CONFIG), and opens a terminal running the system's ssh to the one picked. No real server is reached:
// the hosts end in .invalid, so ssh says it can't resolve them, which shows it ran with that host.
// Run after npm run build. `node ssh.cjs before` only opens the canvas menu in the packaged build, for a before picture.
const fs = require('fs')
const path = require('path')
const L = require('./lib.cjs')

const before = process.argv[2] === 'before'
const c = L.checker()

async function main() {
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const dir = L.workDir('ssh')
  const config = path.join(dir, 'ssh_config')
  fs.writeFileSync(
    config,
    ['# test hosts', 'Host build-box.invalid', '  HostName 10.0.0.1', '', 'Host *.corp !skip', '  User me', '', 'Host web1.invalid web2.invalid', '  Port 2222', ''].join('\r\n')
  )
  const app = await L.launch({ profile, exe: before ? L.packagedExe : undefined, env: { PATCHBAY_SSH_CONFIG: config } })
  const page = app.page
  try {
    await page.mouse.click(760, 300, { button: 'right' })
    await page.waitForSelector('.menu-panel [data-cmd="new-terminal"]')
    if (before) {
      console.log('SHOT', await L.shot(page, 'ssh-before-menu'))
      return
    }
    console.log('SHOT', await L.shot(page, 'ssh-after-menu'))
    c.check('The canvas menu has SSH to host…', !!(await page.$('.menu-panel [data-cmd="new-ssh"]')))
    await page.click('.menu-panel [data-cmd="new-ssh"]')
    await page.waitForSelector('.pop-ssh', { timeout: 5000 })
    const listed = await L.waitFor('the hosts', async () => {
      const hosts = await page.$$eval('.pop-ssh [data-ssh-host]', (els) => els.map((e) => e.dataset.sshHost))
      return hosts.length ? hosts : null
    }, 5000).catch(() => [])
    c.check('It lists the named hosts from the ssh config, without patterns', JSON.stringify(listed) === JSON.stringify(['build-box.invalid', 'web1.invalid', 'web2.invalid']), listed)
    console.log('SHOT', await L.shot(page, 'ssh-after-form'))

    await page.type('.pop-ssh input[name="sshHost"]', '-oProxyCommand=calc')
    const refused = await page.$eval('.pop-ssh button.btn-solid', (b) => b.disabled)
    const why = await page.$eval('.pop-ssh .field-problem', (e) => e.textContent).catch(() => '')
    c.check('A host that would be read as an ssh option can’t be opened', refused && /isn’t a host name/.test(why), { refused, why })
    await page.$eval('.pop-ssh input[name="sshHost"]', (e) => {
      e.select()
    })
    await page.keyboard.press('Backspace')

    await page.click('.pop-ssh [data-ssh-host="build-box.invalid"]')
    await page.click('.pop-ssh button.btn-solid')
    const node = await L.waitFor('the SSH terminal', async () => (await L.doc(page)).nodes.find((n) => n.kind === 'terminal' && n.sshHost), 10000).catch(() => null)
    c.check('Open adds a terminal for that host, named after it', node?.sshHost === 'build-box.invalid' && node?.title === 'build-box.invalid', node)
    const said = await L.waitFor('ssh to answer', async () => {
      const s = await L.snapshot(page, node.id)
      return /build-box\.invalid/.test(s) && /resolve/i.test(s) ? s : null
    }, 20000).catch((e) => e.message)
    c.check('The terminal runs ssh to that host', /Could not resolve hostname build-box\.invalid/i.test(said), said)
    await L.fitView(page)
    await L.sleep(800)
    console.log('SHOT', await L.shot(page, 'ssh-after-terminal'))

    // A host set some other way, say by an agent, is checked again before ssh starts.
    await L.openNode(page, L.terminal('bad', dir, 700, 0, { sshHost: '-oProxyCommand=calc' }))
    const err = await L.waitFor('the refusal', () => page.evaluate(() => window.patchbay.getErrors().then((e) => e.bad?.message ?? null)), 10000).catch(() => null)
    const ran = await L.snapshot(page, 'bad')
    c.check('Main refuses a host that starts like an option, and starts nothing', !!err && !ran, { err, ran })
    c.check('No errors in the page', app.problems.length === 0, app.problems)
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
