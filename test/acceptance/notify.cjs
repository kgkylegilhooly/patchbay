'use strict'
// The chime, its switch, and the Settings section, with a real Claude reaching a real permission prompt.
// Hearing it, and seeing the badge and the notification, are for the owner: nothing here can observe those.
const fs = require('node:fs')
const path = require('node:path')
const lib = require('./lib.cjs')

const { check, finish } = lib.checker()
const shots = process.env.SHOTS
const PROMPT = (name) => `Use the Write tool to create ${name} containing ok.`

async function main() {
  const hash = lib.settingsHash()
  const profile = lib.newProfile({ permissionMode: 'default' })
  const cwd = lib.workDir('notify')
  const exe = process.argv.includes('--packaged') ? lib.packagedExe : undefined
  const app = await lib.launch({ profile, exe })
  const { page } = app
  const chimes = []
  page.on('console', (m) => {
    if (m.text().startsWith('patchbay-chime')) chimes.push(m.text())
  })
  const settingsFile = path.join(profile, 'settings.json')
  const stop = (id) => page.evaluate((i) => window.patchbay.dispatch({ op: 'removeNodes', ids: [i] }), id)
  const needsYou = (id) => lib.waitFor(`${id} to need you`, async () => (await lib.statusOf(page, id)) === 'needs-you', 120000)

  try {
    await page.keyboard.down('Control')
    await page.keyboard.press('Comma')
    await page.keyboard.up('Control')
    await page.waitForSelector('.settings')
    await page.click('[data-section="notifications"]')
    await lib.sleep(200)
    if (shots) await page.screenshot({ path: path.join(shots, 'settings-notifications.png') })
    const on = await page.$$eval('.settings [role="switch"]', (s) => s.map((e) => e.getAttribute('aria-checked')))
    check('Notifications and sound start on', on.join() === 'true,true', on)
    await page.click('[data-test="chime"]')
    await lib.sleep(300)
    check('The test button plays the chime, and audio is really running', chimes.at(-1) === 'patchbay-chime running' || chimes.at(-1) === 'patchbay-chime suspended', chimes)
    await page.keyboard.press('Escape')
    await lib.sleep(200)
    chimes.length = 0

    await lib.openNode(page, lib.claude('away', cwd, 60, 60, { prompt: PROMPT('away.txt') }))
    await needsYou('away')
    await lib.sleep(500)
    check('A session needing you plays the chime', chimes.length === 1, chimes)
    check('In a running audio context', chimes[0] === 'patchbay-chime running', chimes)
    await lib.sleep(8000)
    check('Claude\'s later reminder of the same prompt does not chime again', chimes.length === 1, chimes)
    await stop('away')
    chimes.length = 0

    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, sound: 'off' }))
    await lib.openNode(page, lib.claude('quiet', cwd, 60, 60, { prompt: PROMPT('quiet.txt') }))
    await needsYou('quiet')
    await lib.sleep(800)
    check('With sound off there is no chime, and no restart was needed', chimes.length === 0, chimes)
    await stop('quiet')

    const result = await Promise.race([page.evaluate(() => window.patchbay.testNotification()), lib.sleep(8000).then(() => 'no answer')])
    console.log(`  (Windows answered the test notification with: ${result})`)
    check('The notification route answers', ['shown', 'failed', 'unsupported', 'no answer'].includes(result), result)

    const problems = app.problems.filter((p) => !p.includes('notification'))
    check('No errors in the page', problems.length === 0, problems)
    check('~/.claude/settings.json is unchanged', lib.settingsHash() === hash)
  } finally {
    await app.forceKill().catch(() => {})
    lib.cleanup(profile)
  }
  finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
