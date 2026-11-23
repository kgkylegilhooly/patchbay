'use strict'
// What the UI checks share: a seeded canvas of real sessions, real key presses, and a limit on how long a run can take.
const fs = require('node:fs')
const path = require('node:path')
const lib = require('./lib.cjs')
const { canvas } = require('./scenes.cjs')

const fake = path.join(__dirname, 'fake-claude.cjs').replace(/\\/g, '/')

/** Runs can't hang: a stuck child or window ends the run as a failure, and a timeout on each step keeps the rest going. */
function watchdog(ms) {
  const timer = setTimeout(() => {
    console.error(`The whole run went over ${ms} ms, so it was stopped.`)
    process.exit(2)
  }, ms)
  timer.unref()
}

function seeded(name) {
  const cwd = lib.workDir(name)
  const profile = lib.newProfile({ claudeCommand: `node "${fake}"`, notifications: 'off', sound: 'off' })
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(canvas(cwd)))
  return { cwd, profile }
}

const MODIFIERS = { ctrl: 'Control', shift: 'Shift', alt: 'Alt' }

/** A real key press, such as chord(page, 'ctrl+shift', 'KeyT'). */
async function chord(page, mods, key) {
  const held = mods ? mods.split('+').map((m) => MODIFIERS[m]) : []
  for (const m of held) await page.keyboard.down(m)
  await page.keyboard.press(key)
  for (const m of held.reverse()) await page.keyboard.up(m)
  await lib.sleep(150)
}

/** A spot on the bare canvas, wherever the windows happen to be. */
const emptySpot = (page) =>
  page.evaluate(() => {
    const stage = document.querySelector('.stage').getBoundingClientRect()
    for (let y = stage.top + 20; y < stage.bottom - 20; y += 20) {
      for (let x = stage.right - 20; x > stage.left + 20; x -= 20) {
        if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y }
      }
    }
    throw new Error('No bare canvas on screen')
  })

const nodeSel = (id) => `.react-flow__node[data-id="${id}"]`

/** Clicks into a terminal so it really has the keyboard. */
async function focusTerminal(page, id) {
  await page.click(`${nodeSel(id)} .xterm-screen, .unit-maximized .xterm-screen`)
  await lib.waitFor(`${id}'s terminal to have the keyboard`, () => page.evaluate(() => !!document.activeElement?.closest('.xterm')), 10000, 50)
}

/** Types into the focused terminal with real keys, then Enter. */
async function typeLine(page, text) {
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/** The shell's own process id, asked of the shell itself, so it can't be fooled by anything in the app. */
async function shellPid(page, id, tag) {
  return askShell(page, id, `echo pid-${tag}-$$`, new RegExp(`pid-${tag}-(\\d+)`), 'its pid')
}

/**
 * Git Bash can drop a character sent just after its window was resized, as these checks often do, and the command then
 * fails. Asking again tells a dropped key from a shell that's really gone, which still fails after every try. Each try
 * waits 6 s, as a shell on a busy machine can take seconds to answer.
 */
async function askShell(page, id, command, answer, what) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await lib.input(page, id, `${command}\r`)
    const said = await lib.waitFor(`${id} to say ${what}`, async () => answer.exec(await lib.snapshot(page, id))?.[1], 6000, 100).catch(() => null)
    if (said) return said
  }
  throw new Error(`${id} never said ${what}`)
}

/** What the program in the terminal has been told its size is. */
async function ptySize(page, id, tag) {
  return askShell(page, id, `echo size-${tag}-$(stty size | tr ' ' x)`, new RegExp(`size-${tag}-(\\d+x\\d+)`), 'its size')
}

const fontSizeOf = (page, id) => page.$eval(`${nodeSel(id)} .xterm-rows`, (r) => parseFloat(getComputedStyle(r).fontSize))
const rowIds = (page, section) => page.$$eval(`${section} [data-session]`, (rows) => rows.map((r) => r.dataset.session))
const active = async (page) => (await lib.doc(page)).activeProjectId
const shownNodes = (page) => page.$$eval('.react-flow__node', (ns) => ns.map((n) => n.dataset.id))

/** Each step reports its own failure, so one problem doesn't hide the state of everything after it. */
function stepper(check, onFail) {
  return async (name, fn) => {
    try {
      await fn()
    } catch (e) {
      check(`${name} ran to the end`, false, e.message.split('\n')[0])
      await onFail?.()
    }
  }
}

/**
 * Runs a row of a session window's ⋯ menu, such as 'chat', 'refresh', 'name' or 'font-larger', opening the menu first
 * unless it is already open on that window. A text size row keeps the menu open.
 */
async function headerTool(page, id, tool) {
  const mine = await page.$(`${nodeSel(id)} [data-tool="more"][aria-expanded="true"]`)
  if (!mine && (await page.$('.menu-panel'))) {
    await page.keyboard.press('Escape')
    await lib.sleep(100)
  }
  if (!mine) {
    await page.click(`${nodeSel(id)} [data-tool="more"]`)
    await page.waitForSelector(`.menu-panel [data-tool="${tool}"]`, { timeout: 3000 })
  }
  await page.click(`.menu-panel [data-tool="${tool}"]`)
  await lib.sleep(100)
}

module.exports = { headerTool, emptySpot, watchdog, seeded, chord, nodeSel, focusTerminal, typeLine, shellPid, ptySize, fontSizeOf, rowIds, active, shownNodes, stepper }
