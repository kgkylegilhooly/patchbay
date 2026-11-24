'use strict'
// Updates on the packaged app, against a feed served on this PC: Check now finds a newer version, downloads it, and
// offers Restart to update, which asks before ending sessions. It never installs: the "installer" is a stand-in file.
// Needs a packaged build. Set PATCHBAY_PACKAGED to test one built elsewhere.
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const L = require('./lib.cjs')

const c = L.checker()

// electron-updater keeps a download here (updaterCacheDirName in build/app-update.yml) and reuses it when the hash
// matches. Cleared before, so the test really downloads, and after, so the stand-in "installer" never stays behind.
const updaterCache = path.join(process.env.LOCALAPPDATA || '', 'patchbay-updater')
const clearCache = () => fs.rmSync(updaterCache, { recursive: true, force: true })

function startFeed() {
  const installer = Buffer.from('not a real installer, never run\n'.repeat(200))
  const sha512 = crypto.createHash('sha512').update(installer).digest('base64')
  const name = 'Patchbay-Setup-9.9.9.exe'
  const latest = [
    'version: 9.9.9',
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${installer.length}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-11-07T00:00:00.000Z'",
    ''
  ].join('\n')
  const asked = []
  const server = http.createServer((req, res) => {
    asked.push(req.url.split('?')[0])
    if (req.url.startsWith('/latest.yml')) return res.end(latest)
    if (req.url.startsWith(`/${name}`)) return res.end(installer)
    res.statusCode = 404
    res.end()
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, asked, close: () => server.close() })))
}

async function main() {
  clearCache()
  const feed = await startFeed()
  const profile = L.newProfile({ updateFeed: `http://127.0.0.1:${feed.port}/`, updateCheck: 'off', notifications: 'off', sound: 'off' })
  const app = await L.launch({ profile, exe: L.packagedExe })
  const page = app.page
  try {
    await page.evaluate(() => [...document.querySelectorAll('.bar button')].find((b) => b.textContent.trim() === 'File').click())
    await page.click('[data-cmd="open-settings"]')
    await page.waitForSelector('.settings')
    await page.click('[data-section="about"]')
    await page.waitForSelector('[data-settings-updates]', { timeout: 5000 })
    c.check('With checks off, nothing asked the feed by itself', feed.asked.length === 0, feed.asked)
    await page.click('[data-update="check"]')
    const status = await L.waitFor('the download', async () => {
      const t = await page.$eval('[data-update-status]', (e) => e.textContent)
      return /ready to install|failed/.test(t) ? t : null
    }, 60000, 500).catch((e) => e.message)
    c.check('Check now finds the newer version and downloads it', /Version 9\.9\.9 is ready to install/.test(status), status)
    c.check('It asked the feed and fetched the file', feed.asked.includes('/latest.yml') && feed.asked.some((u) => u.endsWith('.exe')), feed.asked)
    console.log('SHOT', await L.shot(page, 'updates-after-ready'))
    await page.click('[data-update="restart"]')
    const warning = await page.$eval('[data-update-confirm="restart"] .confirm-message', (e) => e.textContent).catch(() => '')
    c.check('Restart to update first says that sessions end, and asks again', /ends every running session/.test(warning) && !!(await page.$('[data-update="restart-confirm"]')), warning)
    console.log('SHOT', await L.shot(page, 'updates-after-confirm'))
    c.check('No errors in the page', app.problems.length === 0, app.problems)
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
    feed.close()
    clearCache()
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
