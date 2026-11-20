'use strict'
// Screenshot scenes for the safe area and the dock's Work menu: `node screenshot.js <out.png> --scene safe-new-nodes`
// (and safe-fit, safe-fit-nosidebar, safe-tidy, safe-header-zoom, safe-legend, safe-git, work-menu). Take each at the
// default size and at --size 1024x700: the overlays (sidebar, dock, minimap, legend) crowd the canvas most there.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dockClick = (page, cmd) =>
  page.evaluate((c) => [...document.querySelectorAll(`[data-cmd="${c}"]`)].find((b) => b.closest('.dock'))?.click(), cmd)

const settle = async (page) => {
  await page.waitForSelector('.react-flow__node[data-id="idle"]', { timeout: 10000 })
  await sleep(600)
}

const hideSidebar = async (page) => {
  if (await page.$('.sidebar')) await dockClick(page, 'toggle-sidebar')
  await sleep(250)
}

const showLegend = async (page) => {
  await page.evaluate(() => [...document.querySelectorAll('.menubar-item')].find((b) => b.textContent === 'View').click())
  await sleep(150)
  if (!(await page.$('.legend'))) await page.click('.menu-panel [data-cmd="toggle-legend"]')
  else await page.keyboard.press('Escape')
  await sleep(200)
}

/** Throws, failing the picture, when the node's box on screen meets the sidebar, dock, minimap or legend. */
const assertClear = (page, id) =>
  page.evaluate((nodeId) => {
    const el = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`)
    if (!el) throw new Error(`New node ${nodeId} isn't drawn`)
    const a = el.getBoundingClientRect()
    for (const sel of ['.stage > .sidebar', '.stage > .dock', '.react-flow__minimap', '.stage > .legend']) {
      const c = document.querySelector(sel)?.getBoundingClientRect()
      if (c && c.width && a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom) throw new Error(`New node ${nodeId} is under ${sel}`)
    }
  }, id)

const nodeIds = (page) => page.evaluate(() => [...document.querySelectorAll('.react-flow__node')].map((n) => n.dataset.id))

const scenes = {
  'safe-canvas': settle,
  'safe-fit': async (page) => {
    await settle(page)
    await dockClick(page, 'fit-view')
    await sleep(500)
  },
  'safe-fit-nosidebar': async (page) => {
    await settle(page)
    await hideSidebar(page)
    await dockClick(page, 'fit-view')
    await sleep(500)
  },
  // Two notes and a browser opened in the middle of the view: each must land clear of the sidebar, dock and minimap.
  'safe-new-nodes': async (page) => {
    await settle(page)
    for (const kind of ['browser', 'note', 'note']) {
      const before = new Set(await nodeIds(page))
      await dockClick(page, 'add')
      await sleep(150)
      await page.click(`.menu-panel [data-cmd="${kind === 'note' ? 'new-sticky' : 'new-browser'}"]`)
      await sleep(600)
      // The node just made is always in the clear; earlier ones too, whenever they all fit in the view together.
      const made = (await nodeIds(page)).filter((id) => !before.has(id))
      for (const id of made) await assertClear(page, id)
    }
    await sleep(500)
  },
  'safe-tidy': async (page) => {
    await settle(page)
    await dockClick(page, 'tidy')
    await sleep(600)
  },
  'safe-header-zoom': async (page) => {
    await settle(page)
    await showLegend(page)
    const spot = await page.evaluate(() => {
      const head = document.querySelector('.react-flow__node[data-id="idle"] .unit-head')
      const r = head.getBoundingClientRect()
      for (let x = r.left + r.width * 0.55; x < r.right - 4; x += 4) {
        const hit = document.elementFromPoint(x, r.top + r.height / 2)
        if (hit === head || hit?.classList.contains('cwd')) return { x, y: r.top + r.height / 2 }
      }
      return { x: r.left + r.width * 0.6, y: r.top + r.height / 2 }
    })
    await page.mouse.click(spot.x, spot.y, { count: 2 })
    await sleep(700)
  },
  'safe-legend': async (page) => {
    await settle(page)
    await showLegend(page)
    await dockClick(page, 'fit-view')
    await sleep(500)
  },
  'safe-git': async (page) => {
    await settle(page)
    await dockClick(page, 'toggle-git')
    await sleep(700)
  },
  // Closed conversations, now in the Work menu: it must still open the drawer.
  'work-recent': async (page) => {
    await settle(page)
    await dockClick(page, 'work')
    await page.waitForSelector('.dock .menu-panel [data-cmd="recent"]', { timeout: 5000 })
    await page.evaluate(() => document.querySelector('.dock .menu-panel [data-cmd="recent"]').click())
    await page.waitForSelector('.drawer .recent-entry', { timeout: 5000 })
    await sleep(300)
  },
  // At 1024x700 with the sidebar open the minimap folds into the dock; this shows it opened from there.
  'safe-map-open': async (page) => {
    await settle(page)
    await dockClick(page, 'toggle-map')
    await sleep(400)
  },
  'work-menu': async (page) => {
    await settle(page)
    await dockClick(page, 'work')
    await sleep(400)
    const over = await page.evaluate(() => {
      const r = document.querySelector('.dock .menu-panel')?.getBoundingClientRect()
      return r ? { right: r.right, left: r.left, width: window.innerWidth } : null
    })
    if (!over) throw new Error('The Work menu did not open')
    if (over.right > over.width || over.left < 0) throw new Error(`The Work menu runs off the window: ${JSON.stringify(over)}`)
  }
}

const seeds = {
  // The view opens on the right-hand nodes, so new ones have to find room near the minimap and dock.
  'safe-new-nodes': (doc) => {
    doc.viewport = { x: -560, y: 40, zoom: 0.72 }
  }
}

module.exports = { scenes, seeds }
