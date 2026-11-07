'use strict'
// Quitting and leaving sessions running must end the process every time, however soon after launch it happens.
// Electron's exit can hang now and then, which would hold the single-instance lock and block the next launch. The
// exit guard covers that, so this repeats the quit and counts both outcomes. A guarded exit takes about 4 s, and any
// slower than that is a failure.
//
//   node test/acceptance/quitloop.cjs [rounds] [--new-profile] [--new-host] [--fresh] [--delay=MS] [--relaunch]
//
// --new-profile uses a brand-new profile every round, which is when the hang has shown up: the first quit, soon
// after the first launch. --fresh starts a session in every round, not just the first. --delay waits that long
// before quitting, instead of a different moment each round.
const lib = require('./lib.cjs')
const { sleep, launch, openNode, terminal, waitFor, snapshot, checker, newProfile, workDir, cleanup } = lib

const rounds = Number(process.argv[2]) || 12
const fresh = process.argv.includes('--fresh')
const eachNew = process.argv.includes('--new-profile')
const newHost = process.argv.includes('--new-host')
const relaunch = process.argv.includes('--relaunch')
const relaunches = []
const delayArg = process.argv.find((a) => a.startsWith('--delay='))
const delay = delayArg ? Number(delayArg.slice('--delay='.length)) : null
const env = process.env.QUITLOOP_ENV ? JSON.parse(process.env.QUITLOOP_ENV) : undefined
setTimeout(() => {
  console.error('FAIL  the whole run went over its time limit')
  process.exit(2)
}, (rounds + 1) * 45000).unref()

async function main() {
  const c = checker()
  const work = workDir('quit-loop')
  let profile = newProfile()
  let stalls = 0
  const times = []
  try {
    for (let i = 0; i < rounds; i++) {
      if (eachNew && i > 0) {
        cleanup(profile)
        profile = newProfile()
      }
      // Keeps the profile, but ends its host, so each launch has to start a new one.
      if (newHost && i > 0) {
        lib.stopHostOf(profile)
        await sleep(500)
      }
      const app = await launch({ profile, env })
      if (i === 0 || fresh || eachNew) {
        const id = `t${i}`
        await openNode(app.page, terminal(id, work, 40 + i * 10, 40, { command: 'echo looping' }))
        await waitFor('the terminal', async () => (await snapshot(app.page, id)).includes('looping'), 20000)
      }
      await sleep(delay ?? (i % 4) * 700)
      if (relaunch) {
        // Asks it to quit and opens Patchbay again straight away, as someone might. The new one must open, not quit.
        const asked = Date.now()
        await app.page.evaluate(() => window.patchbay.quitApp()).catch(() => {})
        const oldGone = app.exited.then(() => Date.now() - asked)
        let opened = false
        try {
          const next = await launch({ profile, env })
          opened = true
          await next.quitLeavingSessions(10000)
        } catch (e) {
          console.log(`round ${i}: the relaunch did not open: ${e.message}`)
        }
        const oldMs = await Promise.race([oldGone, sleep(15000).then(() => null)])
        relaunches.push({ opened, oldMs })
        app.browser.disconnect()
        continue
      }
      const started = Date.now()
      try {
        await app.quitLeavingSessions(10000)
        times.push(Date.now() - started)
      } catch (e) {
        stalls++
        console.log(`round ${i}: ${e.message}`)
        cleanup(profile)
        if (!eachNew) profile = newProfile()
        await sleep(500)
      }
    }
    if (relaunch) {
      const failed = relaunches.filter((r) => !r.opened).length
      const hung = relaunches.filter((r) => r.oldMs === null || r.oldMs > 3500).length
      c.check(`every one of ${rounds} immediate relaunches opened`, failed === 0, `${failed} failed to open; the instance quitting hung in ${hung} of them`)
    } else {
      const guarded = times.filter((t) => t > 2000).length
      c.check(`every one of ${rounds} quits ended the process`, stalls === 0, `${stalls} stalled, ${guarded} needed the guard, slowest ${Math.max(0, ...times)} ms`)
    }
  } finally {
    cleanup(profile)
  }
  c.finish()
  setTimeout(() => process.exit(process.exitCode ?? 0), 500)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
