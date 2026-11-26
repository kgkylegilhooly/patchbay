'use strict'
// Named canvases for `node screenshot.js <out.png> --scene <name>`. The Claude windows run fake-claude.cjs, so every
// status shows for real with no plan quota spent. The same scenes make the before and after pictures.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const box = { parentId: null, width: 560, height: 300 }
const view = { x: 0, y: 0, zoom: 0.8 }

function canvas(cwd) {
  const claude = (id, title, x, y, prompt, projectId = 'p1', extra = {}) => ({
    ...box, id, kind: 'claude', title, x, y, cwd, prompt, sessionId: null, transcriptPath: null, after: [], projectId, ...extra
  })
  const terminal = (id, title, x, y, projectId = 'p1', extra = {}) => ({ ...box, id, kind: 'terminal', title, x, y, cwd, projectId, ...extra })
  return {
    version: 2,
    projects: [
      { id: 'p1', name: 'Patchbay', folder: cwd, viewport: view },
      { id: 'p2', name: 'Website', folder: cwd, viewport: view }
    ],
    activeProjectId: 'p1',
    viewport: { x: 300, y: 20, zoom: 0.72 },
    edges: [],
    closed: [
      { id: 'closed-b', title: 'Landing page copy', cwd, sessionId: 'aaaaaaaa-0000-4000-8000-000000000002', transcriptPath: null, closedAt: Date.now() - 26 * 3600_000, projectId: 'p2' },
      { id: 'closed-a', title: 'Parser review', cwd, sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', transcriptPath: null, closedAt: Date.now() - 40 * 60_000, projectId: 'p1' }
    ],
    nodes: [
      { id: 'g1', kind: 'group', title: 'Backend', x: 0, y: 0, width: 620, height: 700, parentId: null, worktree: null, projectId: 'p1' },
      claude('needs', 'Fix the login', 24, 64, 'needs context=71', 'p1', { parentId: 'g1' }),
      claude('work', 'Write parser tests', 24, 380, 'working context=38', 'p1', { parentId: 'g1' }),
      claude('idle', 'Review the docs', 660, 0, 'idle context=12'),
      claude('unk', 'Old agent', 660, 330, 'unknown'),
      terminal('term', 'Dev shell', 1240, 0),
      { ...box, id: 'run', kind: 'run', title: 'npm test', x: 1240, y: 330, cwd, command: 'echo run-finished', projectId: 'p1' },
      { id: 'note', kind: 'sticky', title: 'Note', text: '## Plan\n- Fix login\n- Ship', x: 660, y: 660, width: 240, height: 150, parentId: null, projectId: 'p1' },
      terminal('w-term', 'Site server', 40, 40, 'p2'),
      claude('w-idle', 'Landing page', 640, 40, 'idle context=55', 'p2')
    ]
  }
}

const rightClickCanvas = async (page) => {
  const spot = await page.evaluate(() => {
    const stage = document.querySelector('.stage').getBoundingClientRect()
    for (let y = stage.bottom - 40; y > stage.top; y -= 20) {
      for (let x = stage.left + stage.width / 2; x < stage.right; x += 20) {
        if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y }
      }
    }
    return { x: stage.right - 120, y: stage.bottom - 160 }
  })
  await page.mouse.click(spot.x, spot.y, { button: 'right' })
}

const fitAll = async (page) => {
  await page.evaluate(() => [...document.querySelectorAll('[data-cmd="fit-view"]')].find((b) => b.closest('.dock'))?.click())
  await sleep(500)
}

/** One of each kind of link, so a picture can show how they differ. */
const seedLinks = (page) =>
  page.evaluate(async () => {
    const edge = (id, from, to, kind) => window.patchbay.dispatch({ op: 'addEdge', edge: { id, from, to, kind } })
    await edge('e-open', 'idle', 'term', 'opened')
    await edge('e-link', 'unk', 'run', 'link')
    await edge('e-after', 'work', 'unk', 'after')
    // Far enough apart that each cable can be seen.
    const move = (id, x, y) => window.patchbay.dispatch({ op: 'patchNode', id, patch: { x, y } })
    await move('idle', 860, 0)
    await move('unk', 860, 400)
    await move('term', 1700, 0)
    await move('run', 1700, 400)
  })

/** A trigger beside the terminal, aimed at it, next to the Claude window it could also reach. */
const seedTrigger = (page) =>
  page.evaluate(async () => {
    await window.patchbay.dispatch({
      op: 'addNode',
      node: {
        id: 'trig', kind: 'trigger', title: 'Nightly check', x: 900, y: 680, width: 360, height: 400, parentId: null, projectId: 'p1',
        schedule: { type: 'interval', everyMs: 600000 }, prompt: 'echo checking the build', targetId: 'term', armedSpec: null, armedAt: null, nextAt: null, runs: []
      }
    })
  })

const showLegend = async (page) => {
  await page.evaluate(() => [...document.querySelectorAll('.menubar-item')].find((b) => b.textContent === 'View').click())
  await sleep(150)
  if (!(await page.$('.legend'))) await page.click('.menu-panel [data-cmd="toggle-legend"]')
  else await page.keyboard.press('Escape')
  await sleep(150)
}

/** An agent asking to run a command longer than its window is wide, brought to the middle of the view. */
const seedApproval = async (page) => {
  const node = { ...box, id: 'asks', kind: 'claude', title: 'Ship the fix', x: 930, y: 640, prompt: 'permission', sessionId: null, transcriptPath: null, after: [], projectId: 'p1' }
  await page.evaluate(async (n) => {
    const cwd = (await window.patchbay.getDoc()).nodes.find((o) => o.id === 'term').cwd
    await window.patchbay.dispatch({ op: 'addNode', node: { ...n, cwd } })
    await window.patchbay.startNode(n.id)
  }, node)
  await page.waitForSelector('.react-flow__node[data-id="asks"] .strip-approval', { timeout: 15000 })
  await page.evaluate(() => [...document.querySelectorAll('.session')].find((s) => s.textContent.includes('Ship the fix'))?.click())
  await sleep(600)
}

/** Makes the project's folder a git repository with one commit, as a worktree needs. */
const gitRepoProject = async (page) => {
  const folder = await page.evaluate(async () => (await window.patchbay.getDoc()).projects[0].folder)
  const { execFileSync } = require('node:child_process')
  const git = (...args) => execFileSync('git', ['-C', folder, '-c', 'user.name=Scene', '-c', 'user.email=scene@example.invalid', ...args], { stdio: 'ignore', windowsHide: true })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'Scene')
}

/** Each one prepares what the picture shows, once the seeded canvas is up. Selectors that only exist after a change are guarded. */
const scenes = {
  'browser-evidence': (page) => require('../browser/evidenceScene.cjs').act(page),
  canvas: async () => {},
  links: async (page) => {
    await seedLinks(page)
    await showLegend(page)
    await page.click('[data-cmd="toggle-sidebar"]')
    await sleep(200)
    await fitAll(page)
  },
  'links-reduced': async (page) => {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await scenes.links(page)
  },
  trigger: async (page) => {
    await seedTrigger(page)
    await page.evaluate(async () => {
      const node = (await window.patchbay.getDoc()).nodes.find((n) => n.id === 'trig')
      const spec = JSON.stringify([['interval', node.schedule.everyMs], node.prompt, node.targetId])
      await window.patchbay.armTrigger('trig', spec)
      await window.patchbay.runTriggerNow('trig')
    })
    await page.click('[data-cmd="toggle-sidebar"]')
    await sleep(800)
    await fitAll(page)
  },
  'trigger-arm': async (page) => {
    await seedTrigger(page)
    await page.click('[data-cmd="toggle-sidebar"]')
    await sleep(300)
    await page.click('.react-flow__node[data-id="trig"] [data-trigger-action="arm"]')
    await sleep(300)
  },
  'trigger-form': async (page) => {
    await rightClickCanvas(page)
    await sleep(200)
    await page.click('.menu-panel [data-cmd="new-trigger"]')
    await sleep(200)
    await page.type('form[aria-label="New trigger"] [name="prompt"]', 'Run the tests and summarize any failures.')
    await page.select('form[aria-label="New trigger"] [name="target"]', 'idle')
    await sleep(200)
  },
  // A start and an end: see src/core/trigger/window.ts. Tomorrow 14:00 until the day after, 09:00.
  'trigger-window-form': async (page) => {
    await rightClickCanvas(page)
    await sleep(200)
    await page.click('.menu-panel [data-cmd="new-trigger"]')
    await sleep(200)
    const form = 'form[aria-label="New trigger"]'
    await page.type(`${form} [name="prompt"]`, 'Check the deploy and report anything failing.')
    await page.select(`${form} [name="target"]`, 'idle')
    await page.evaluate((form) => {
      const pad = (n) => String(n).padStart(2, '0')
      const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
      const day = new Date()
      const set = (name, value) => {
        const input = document.querySelector(`${form} [name="${name}"]`)
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      set('startsAt', local(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 14, 0)))
      set('endsAt', local(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 2, 9, 0)))
    }, form)
    await sleep(200)
  },
  'trigger-window-arm': async (page) => {
    await page.evaluate(async () => {
      const day = new Date()
      const startsAt = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 14, 0).getTime()
      const endsAt = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 2, 9, 0).getTime()
      await window.patchbay.dispatch({
        op: 'addNode',
        node: {
          id: 'trig', kind: 'trigger', title: 'Deploy watch', x: 900, y: 680, width: 360, height: 400, parentId: null, projectId: 'p1',
          schedule: { type: 'interval', everyMs: 300000 }, prompt: 'echo checking the deploy', targetId: 'term', startsAt, endsAt, armedSpec: null, armedAt: null, nextAt: null, runs: []
        }
      })
    })
    await page.click('[data-cmd="toggle-sidebar"]')
    await sleep(300)
    await page.click('.react-flow__node[data-id="trig"] [data-trigger-action="arm"]')
    await sleep(300)
  },
  // Event triggers: see src/core/trigger/events.ts.
  'trigger-events-form': async (page) => {
    await rightClickCanvas(page)
    await sleep(200)
    await page.click('.menu-panel [data-cmd="new-trigger"]')
    await sleep(200)
    const form = 'form[aria-label="New trigger"]'
    await page.select(`${form} [name="scheduleType"]`, 'agent')
    await page.select(`${form} [name="agent"]`, 'work')
    await page.type(`${form} [name="prompt"]`, '{{node}} {{event}}. Review its changes and list any problems.')
    await page.select(`${form} [name="target"]`, 'idle')
    await page.type(`${form} [name="preflight"]`, 'npm test')
    await sleep(200)
  },
  'trigger-events': async (page) => {
    await page.evaluate(async () => {
      const doc = await window.patchbay.getDoc()
      const cwd = doc.projects[0].folder
      const prompt = 'echo {{node}} {{event}}'
      await window.patchbay.dispatch({
        op: 'addNode',
        node: {
          id: 'trig', kind: 'trigger', title: 'When tests finish', x: 1240, y: 680, width: 380, height: 460, parentId: null, projectId: 'p1',
          schedule: { type: 'run', nodeId: 'run', failedOnly: false }, prompt, targetId: 'term', preflight: { argv: ['node', '--version'], cwd },
          limits: { gapMs: 60000, perHour: 10 }, armedSpec: null, armedAt: null, nextAt: null, runs: []
        }
      })
      const spec = JSON.stringify([['run', 'run', false], prompt, 'term', { preflight: [['node', '--version'], cwd], limits: [60000, 10] }])
      const r = await window.patchbay.armTrigger('trig', spec)
      if (!r.ok) throw new Error(r.reason)
      await window.patchbay.startNode('run')
    })
    // The run ends, its check runs, and it fires. A second run inside the cool-down is skipped.
    await page.waitForSelector('.react-flow__node[data-id="trig"] [data-outcome="delivered"]', { timeout: 20000 })
    await page.evaluate(() => window.patchbay.startNode('run'))
    await page.waitForSelector('.react-flow__node[data-id="trig"] [data-outcome="skipped"]', { timeout: 20000 })
    await page.click('[data-cmd="toggle-sidebar"]')
    await sleep(300)
    await fitAll(page)
  },
  'run-config': async (page) => {
    await rightClickCanvas(page)
    await sleep(200)
    await page.click('.menu-panel [data-cmd="new-run-config"]')
    await sleep(800)
  },
  node: async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.session')].find((s) => s.textContent.includes('Dev shell'))?.click())
    await sleep(600)
  },
  narrow: async (page) => {
    await page.evaluate(() => {
      window.patchbay.dispatch({ op: 'patchNode', id: 'term', patch: { width: 300 } })
      window.patchbay.dispatch({ op: 'patchNode', id: 'run', patch: { width: 300 } })
      window.patchbay.dispatch({ op: 'patchNode', id: 'idle', patch: { width: 340 } })
    })
    await sleep(500)
    await page.evaluate(() => [...document.querySelectorAll('.session')].find((s) => s.textContent.includes('Dev shell'))?.click())
    await sleep(600)
  },
  browser: async (page) => {
    // A browser node beside the others, on a blank page, since a picture can't count on the network.
    const box = { kind: 'browser', parentId: null, projectId: 'p1', url: 'about:blank', width: 380, height: 220 }
    await page.evaluate((b) => window.patchbay.dispatch({ op: 'addNode', node: { ...b, id: 'web', title: 'Browser', x: 930, y: 640 } }), box)
    await sleep(1200)
  },
  // A real resume: a turn in a repository, someone else's commit while it's closed, then Restart. See files/away.ts.
  away: async (page, { profile }) => {
    const { execFileSync } = require('node:child_process')
    const fs = require('node:fs')
    const path = require('node:path')
    const repo = path.join(profile, 'away-repo')
    const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { windowsHide: true })
    fs.mkdirSync(repo, { recursive: true })
    fs.writeFileSync(path.join(repo, 'parser.ts'), 'export const a = 1\n')
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('commit', '-q', '-m', 'First')
    const node = { ...box, id: 'away', kind: 'claude', title: 'Parser tests', x: 930, y: 640, width: 620, prompt: 'edits=notes.md', sessionId: null, transcriptPath: null, after: [], projectId: 'p1', cwd: repo }
    await page.evaluate(async (n) => {
      await window.patchbay.dispatch({ op: 'addNode', node: n })
      await window.patchbay.startNode(n.id)
    }, node)
    // The turn ends, and its end snapshot is kept.
    await page.waitForFunction(() => document.querySelector('.react-flow__node[data-id="away"]')?.textContent?.includes('Idle'), { timeout: 30000 }).catch(() => {})
    await sleep(3000)
    // Someone else, while it's closed.
    fs.writeFileSync(path.join(repo, 'parser.ts'), 'export const a = 2\n')
    fs.writeFileSync(path.join(repo, 'lexer.ts'), 'export const b = 1\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'Rework the lexer')
    fs.writeFileSync(path.join(repo, 'README.md'), 'notes\n')
    await page.evaluate(() => window.patchbay.restartNode('away'))
    await page.waitForSelector('.react-flow__node[data-id="away"] .strip-away', { timeout: 20000 }).catch(() => {})
    await page.evaluate(() => [...document.querySelectorAll('.session')].find((s) => s.textContent.includes('Parser tests'))?.click())
    await sleep(600)
  },
  // The same, then Tell it: the strip goes, and the list reaches the agent.
  'away-told': async (page, ctx) => {
    await scenes.away(page, ctx)
    await page.click('.react-flow__node[data-id="away"] [data-cmd="away-tell"]').catch(() => {})
    await sleep(2500)
  },
  // Output selected in the Dev shell, then its window menu: Pin selection to a note sits under Copy.
  'pin-menu': async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.session')].find((s) => s.textContent.includes('Dev shell'))?.click())
    await sleep(800)
    const box = await page.$eval('.react-flow__node[data-id="term"] .xterm-screen', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    await page.mouse.move(box.x + 4, box.y + 6)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 8, box.y + 24, { steps: 8 })
    await page.mouse.up()
    await sleep(200)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 12, { button: 'right' })
    await sleep(300)
  },
  // The same, then the item: a note beside the terminal, cabled to it, holding what was selected.
  'pin-output': async (page) => {
    await scenes['pin-menu'](page)
    await page.click('.menu-panel [data-cmd="pin-selection"]').catch(() => {})
    await sleep(800)
  },
  // An agent that has replied, and its window menu: Copy last reply sits under Find.
  'reply-menu': async (page, { profile }) => {
    const dir = require('node:path').join(profile, 'reply-work')
    require('node:fs').mkdirSync(dir, { recursive: true })
    const node = { ...box, id: 'replier', kind: 'claude', title: 'Release notes', x: 930, y: 640, width: 620, prompt: 'edits=notes.md', sessionId: null, transcriptPath: null, after: [], projectId: 'p1', cwd: dir }
    await page.evaluate(async (n) => {
      await window.patchbay.dispatch({ op: 'addNode', node: n })
      await window.patchbay.startNode(n.id)
    }, node)
    // Its turn starts, then ends with its reply written.
    const shows = (word) => page.waitForFunction((w) => document.querySelector('.react-flow__node[data-id="replier"]')?.textContent?.includes(w), { timeout: 30000 }, word).catch(() => {})
    await shows('Working')
    await shows('Idle')
    await page.evaluate(() => [...document.querySelectorAll('.session')].find((s) => s.textContent.includes('Release notes'))?.click())
    await sleep(800)
    const box2 = await page.$eval('.react-flow__node[data-id="replier"] .xterm-screen', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    await page.mouse.click(box2.x + box2.width / 2, box2.y + box2.height - 12, { button: 'right' })
    await sleep(300)
  },
  // A run that fails with a test error: its header offers Ask an agent to fix (F31).
  'run-failed': async (page, { profile }) => {
    const path = require('node:path')
    const dir = path.join(profile, 'fix-work')
    require('node:fs').mkdirSync(dir, { recursive: true })
    require('node:fs').writeFileSync(
      path.join(dir, 'check.cjs'),
      "console.log(' RUN  v5.1.0')\nconsole.log(' FAIL  test/parser.test.ts > splits quoted fields')\nconsole.log('AssertionError: expected [ \\'a\\', \\'b,c\\' ] to deeply equal [ \\'a\\', \\'b\\', \\'c\\' ]')\nconsole.log(' Tests  1 failed | 41 passed (42)')\nprocess.exit(1)\n"
    )
    const node = { ...box, id: 'failing', kind: 'run', title: 'Parser tests', x: 930, y: 640, width: 620, height: 300, parentId: null, projectId: 'p1', cwd: dir, command: 'node check.cjs' }
    await page.evaluate(async (n) => {
      await window.patchbay.dispatch({ op: 'addNode', node: n })
      await window.patchbay.startNode(n.id)
    }, node)
    await page.waitForSelector('.react-flow__node[data-id="failing"] [data-cmd="ask-to-fix"]', { timeout: 30000 }).catch(() => {})
    await page.evaluate(() => [...document.querySelectorAll('.session')].find((s) => s.textContent.includes('Parser tests'))?.click())
    await sleep(800)
  },
  // The same, then the button: the New agent form, in the run's folder, with the brief filled in.
  'run-fix-form': async (page, ctx) => {
    await scenes['run-failed'](page, ctx)
    await page.click('.react-flow__node[data-id="failing"] [data-cmd="ask-to-fix"]').catch(() => {})
    await sleep(1000)
  },
  // The same, then Start: the agent opens beside the run, linked to it, with the brief as its prompt.
  'run-fix-started': async (page, ctx) => {
    await scenes['run-fix-form'](page, ctx)
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')
    await sleep(2500)
    const made = await page.evaluate(async () => {
      const doc = await window.patchbay.getDoc()
      const agent = doc.nodes.find((n) => n.kind === 'claude' && n.cwd.endsWith('fix-work'))
      const linked = agent && doc.edges.some((e) => e.kind === 'link' && e.from === 'failing' && e.to === agent.id)
      return { agent: !!agent, linked: !!linked, title: agent?.title }
    })
    if (!made.agent || !made.linked || made.title !== 'Fix Parser tests') throw new Error(`After Start: ${JSON.stringify(made)}`)
    console.log('run fix: agent opened beside the run, linked to it')
  },
  // A new agent, still called "Claude", is asked to write the release notes: its first prompt becomes its name (F29).
  'auto-title': async (page, ctx) => scenes['auto-title-from'](page, ctx, 'Write_the_release_notes_for_1.4,_from_the_merged_PRs_since_1.3'),
  // The same, when the first thing it hears is a `patchbay send` from a lead: named from the message, not its header.
  'auto-title-sent': async (page, ctx) => scenes['auto-title-from'](page, ctx, '[Patchbay_message_from_Team_lead_(node_1a2b3c)._Reply_with:_patchbay_send_--node_1a2b3c]|Add_retries_to_the_uploader'),
  'auto-title-from': async (page, { profile }, ask) => {
    const dir = require('node:path').join(profile, 'title-work')
    require('node:fs').mkdirSync(dir, { recursive: true })
    const node = { ...box, id: 'named', kind: 'claude', title: 'Claude', x: 930, y: 640, width: 620, prompt: `edits=notes.md ask=${ask}`, sessionId: null, transcriptPath: null, after: [], projectId: 'p1', cwd: dir }
    await page.evaluate(async (n) => {
      await window.patchbay.dispatch({ op: 'addNode', node: n })
      await window.patchbay.startNode(n.id)
    }, node)
    const shows = (word) => page.waitForFunction((w) => document.querySelector('.react-flow__node[data-id="named"]')?.textContent?.includes(w), { timeout: 30000 }, word).catch(() => {})
    await shows('Working')
    await shows('Idle')
    await page.evaluate(() => [...document.querySelectorAll('.react-flow__node[data-id="named"] .xterm-screen')][0]?.click())
    await sleep(800)
  },
  // The same, then the item: the reply is on the clipboard, and the notice says so.
  'reply-copied': async (page, ctx) => {
    await scenes['reply-menu'](page, ctx)
    await page.click('.menu-panel [data-cmd="copy-last-reply"]').catch(() => {})
    await sleep(600)
  },
  // The same, then Save conversation…: the save dialog is answered by PB_SCENE_SAVE_AS (seeded below, test runs only), and
  // the notice says where the Markdown went. The file is checked too.
  'conversation-saved': async (page, ctx) => {
    await scenes['reply-menu'](page, ctx)
    await page.click('.menu-panel [data-cmd="save-conversation"]').catch(() => {})
    await sleep(1200)
    const file = `${process.env.PB_SCENE_SAVE_AS}.md`
    const text = require('node:fs').readFileSync(file, 'utf8')
    if (!text.startsWith('# Release notes\n') || !text.includes('\n## You\n') || !text.includes('\n## Claude Code\n')) throw new Error(`The saved file holds: ${text.slice(0, 300)}`)
    console.log(`conversation saved: ${file}, ${text.length} characters`)
  },
  // An agent edits a file in a repository and doesn't commit it, then its ✕ is pressed: Close asks first.
  'close-guard': async (page, { profile }) => {
    const { execFileSync } = require('node:child_process')
    const fs = require('node:fs')
    const path = require('node:path')
    const repo = path.join(profile, 'guard-repo')
    const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { windowsHide: true })
    fs.mkdirSync(repo, { recursive: true })
    fs.writeFileSync(path.join(repo, 'README.md'), 'first\n')
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('commit', '-q', '-m', 'First')
    const node = { ...box, id: 'guarded', kind: 'claude', title: 'Release notes', x: 930, y: 640, width: 620, prompt: 'edits=notes.md', sessionId: null, transcriptPath: null, after: [], projectId: 'p1', cwd: repo }
    await page.evaluate(async (n) => {
      await window.patchbay.dispatch({ op: 'addNode', node: n })
      await window.patchbay.startNode(n.id)
    }, node)
    const shows = (word) => page.waitForFunction((w) => document.querySelector('.react-flow__node[data-id="guarded"]')?.textContent?.includes(w), { timeout: 30000 }, word).catch(() => {})
    await shows('Working')
    await shows('Idle')
    await page.evaluate(() => [...document.querySelectorAll('.session')].find((s) => s.textContent.includes('Release notes'))?.click())
    await sleep(800)
    await page.click('.react-flow__node[data-id="guarded"] [data-tool="close"]').catch(() => {})
    await sleep(800)
  },
  // The File menu, open.
  'menubar-file': async (page) => {
    await sleep(500)
    await page.evaluate(() => [...document.querySelectorAll('.menubar-item')].find((b) => b.textContent === 'File').click())
    await sleep(300)
  },
  // File > Restore canvas from, and today's copy picked: the question before anything restarts. Never answered here.
  'restore-canvas': async (page) => {
    await scenes['menubar-file'](page)
    // Opened again so the menu is built with the list read at start.
    await page.keyboard.press('Escape')
    await sleep(200)
    await page.evaluate(() => [...document.querySelectorAll('.menubar-item')].find((b) => b.textContent === 'File').click())
    await sleep(300)
    await page.click('.menu-panel [data-cmd="restore-canvas"]').catch(() => {})
    await sleep(400)
    await page.evaluate(() => document.querySelector('[data-cmd^="restore-canvas:"]')?.click())
    await sleep(500)
  },
  // Old agent stopped on an error: Continue sends "continue", and it gets going again.
  'continue-stop': async (page) => {
    await page.waitForSelector('.react-flow__node[data-id="unk"] [data-cmd="continue-after-stop"]', { timeout: 15000 }).catch(() => {})
    await page.click('.react-flow__node[data-id="unk"] [data-cmd="continue-after-stop"]').catch(() => {})
    await sleep(3000)
  },
  // The Dev shell's window menu, then Duplicate: a second shell in the same folder, beside it.
  'duplicate-window': async (page) => {
    await scenes['pin-menu'](page)
    await page.click('.menu-panel [data-cmd="duplicate"]').catch(() => {})
    await sleep(1500)
  },
  // F32: the Dev shell linked to Review the docs, text selected, and its window menu: Send selection to Review the docs.
  'send-selection-menu': async (page) => {
    await page.evaluate(() => window.patchbay.dispatch({ op: 'addEdge', edge: { id: 'send-link', from: 'term', to: 'idle', kind: 'link' } }))
    await sleep(300)
    await scenes['pin-menu'](page)
  },
  // The same, then the item: the agent gets the text, and a line says so.
  'send-selection-sent': async (page) => {
    await scenes['send-selection-menu'](page)
    await page.click('.menu-panel [data-cmd="send-selection"]').catch(() => {})
    await sleep(2500)
  },
  // F30: Review the docs and the Backend group (two agents) selected, and the canvas menu: Send to 3 agents.
  'send-many-menu': async (page) => {
    await sleep(1500)
    const head = async (id) => (await page.$(`.react-flow__node[data-id="${id}"]`)).boundingBox()
    const idle = await head('idle')
    await page.mouse.click(idle.x + 120, idle.y + 14)
    const group = await head('g1')
    await page.keyboard.down('Control')
    await page.mouse.click(group.x + 60, group.y + 12)
    await page.keyboard.up('Control')
    await sleep(300)
    await page.mouse.click(600, 660, { button: 'right' })
    await sleep(400)
  },
  // The same, then the box, with a message typed.
  'send-many-box': async (page) => {
    await scenes['send-many-menu'](page)
    await page.click('.menu-panel [data-cmd="send-to-agents"]').catch(() => {})
    await page.waitForSelector('[data-send-many="text"]', { timeout: 5000 }).catch(() => {})
    await page.keyboard.type('Stop and commit what you have, then rebase on main.')
    await sleep(300)
  },
  // The same, sent with Ctrl+Enter: who got it now and who gets it once idle.
  'send-many-sent': async (page) => {
    await scenes['send-many-box'](page)
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')
    await sleep(2500)
  },
  // F36: a group whose two agents exited, and its menu: Restart 2 stopped windows.
  'restart-stopped-menu': async (page) => {
    const g = { id: 'g-done', kind: 'group', title: 'Nightly batch', x: 930, y: 640, width: 1120, height: 380, parentId: null, worktree: null, projectId: 'p1' }
    const agentIn = (id, title, x) => ({ ...box, id, kind: 'claude', title, x, y: 50, width: 500, height: 300, prompt: 'exit', sessionId: null, transcriptPath: null, after: [], projectId: 'p1', parentId: 'g-done' })
    await page.evaluate(async (nodes) => {
      for (const n of nodes) await window.patchbay.dispatch({ op: 'addNode', node: n })
      for (const n of nodes.slice(1)) await window.patchbay.startNode(n.id)
    }, [g, agentIn('done-a', 'Migrate users', 30), agentIn('done-b', 'Migrate orders', 590)])
    await page.waitForFunction(() => ['done-a', 'done-b'].every((id) => /Exited|Stopped|Restart/.test(document.querySelector(`.react-flow__node[data-id="${id}"]`)?.textContent ?? '')), { timeout: 30000 }).catch(() => {})
    await page.evaluate(() => [...document.querySelectorAll('.session')].find((s) => s.textContent.includes('Migrate users'))?.click())
    await sleep(800)
    const head = await (await page.$('.react-flow__node[data-id="g-done"]')).boundingBox()
    await page.mouse.click(head.x + 200, head.y + 12, { button: 'right' })
    await sleep(400)
  },
  // The same, then the item, with the two told to stay up this time: both come back.
  'restart-stopped-done': async (page) => {
    await scenes['restart-stopped-menu'](page)
    await page.evaluate(async () => {
      for (const id of ['done-a', 'done-b']) await window.patchbay.dispatch({ op: 'patchNode', id, patch: { prompt: 'idle context=9' } })
    })
    await page.click('.menu-panel [data-cmd="restart-stopped"]').catch(() => {})
    await page.waitForFunction(() => ['done-a', 'done-b'].every((id) => /Idle/.test(document.querySelector(`.react-flow__node[data-id="${id}"]`)?.textContent ?? '')), { timeout: 30000 }).catch(() => {})
    await sleep(500)
  },
  // F39: prompts used before, and the New Claude Code form with Recent open.
  'recent-prompts': async (page) => {
    await page.evaluate(() => localStorage.setItem('patchbay.recentPrompts', JSON.stringify([
      'Run the tests and fix what fails, then commit.',
      'Review the open PR for security issues and leave comments as a note on the canvas.',
      'Rebase on main and resolve conflicts'
    ])))
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('KeyC')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')
    await page.waitForSelector('.pop-claude [data-recent-prompts]', { timeout: 5000 }).catch(() => {})
    await page.click('.pop-claude [data-recent-prompts]').catch(() => {})
    await sleep(400)
  },
  // The same, with the second prompt picked: it fills the box, ready to start.
  'recent-prompts-picked': async (page) => {
    await scenes['recent-prompts'](page)
    await page.click('.menu-panel [data-cmd="recent-prompt:1"]').catch(() => {})
    await sleep(400)
  },
  // Review the docs' window menu: Mute notifications.
  'mute-menu': async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.session')].find((s) => s.textContent.includes('Review the docs'))?.click())
    await sleep(800)
    const box = await page.$eval('.react-flow__node[data-id="idle"] .xterm-screen', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 12, { button: 'right' })
    await sleep(300)
  },
  // The same, then muted: the bell with a line through it beside its title.
  'muted-window': async (page) => {
    await scenes['mute-menu'](page)
    await page.click('.menu-panel [data-cmd="toggle-mute"]').catch(() => {})
    await sleep(500)
  },
  'canvas-menu': async (page) => {
    await rightClickCanvas(page)
    await sleep(200)
  },
  // The last menu in the bar, open: Help.
  'menubar-last': async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.menubar-item')].at(-1).click())
    await sleep(200)
  },
  // Alt+Shift+3 on the canvas keeps the view in slot 3, and says so.
  'saved-view': async (page) => {
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.down('Alt')
    await page.keyboard.down('Shift')
    await page.keyboard.press('Digit3')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Alt')
    await sleep(300)
  },
  'approval-line': (page) => seedApproval(page),
  approval: async (page) => {
    await seedApproval(page)
    await page.evaluate(() => document.querySelector('.react-flow__node[data-id="asks"] .strip-more')?.click())
    await sleep(200)
  },
  status: async (page) => {
    await page.click('[data-sidebar-tab="status"]')
    await sleep(200)
    await page.click('[data-section="recent"]')
    await sleep(200)
  },
  palette: async (page) => {
    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')
    await sleep(200)
    await page.type('.palette-input', 'new')
    await sleep(200)
  },
  shortcuts: async (page) => {
    await page.keyboard.down('Control')
    await page.keyboard.press(',')
    await page.keyboard.up('Control')
    await sleep(300)
    await page.click('[data-section="keys"]')
    await sleep(200)
    await page.click('[data-bind="tidy"]')
    await page.keyboard.down('Control')
    await page.keyboard.press('r')
    await page.keyboard.up('Control')
    await sleep(200)
  },
  // The recipe picker's preview, from the canvas menu, in a project folder that's a git repository.
  recipes: async (page) => {
    await gitRepoProject(page)
    await rightClickCanvas(page)
    await sleep(200)
    if (!(await page.$('.menu-panel [data-cmd="new-from-recipe"]'))) return
    await page.click('.menu-panel [data-cmd="new-from-recipe"]')
    await page.waitForSelector('[data-recipe="Implement and review"]', { timeout: 5000 })
    await page.type('.recipe-params textarea', 'Add dark mode to the settings page')
    await sleep(300)
  },
  // Save selection as recipe, on an agent whose prompt holds a token and names a node outside the selection.
  'recipes-save': async (page) => {
    await gitRepoProject(page)
    await page.evaluate(async () => {
      const prompt = 'Review the docs, publish with GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123, then report with patchbay send --node 0b2d7b0e-6391-463b-883c-7ba575320d69'
      await window.patchbay.dispatch({ op: 'patchNode', id: 'idle', patch: { prompt } })
    })
    await page.waitForSelector('.react-flow__node[data-id="idle"] .unit-head', { timeout: 10000 })
    await sleep(800)
    await page.click('.react-flow__node[data-id="idle"] .unit-head')
    await sleep(200)
    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')
    await sleep(200)
    await page.type('.palette-input', 'save selection as recipe')
    await sleep(200)
    await page.keyboard.press('Enter')
    await sleep(300)
    if (!(await page.$('.recipe-save'))) return
    await page.type('.recipe-save input', 'Review and publish')
    const radios = await page.$$('.recipe-save input[name="recipe-where"]')
    if (radios[1]) await radios[1].click()
    await sleep(300)
  },
  // A recipe started with a setup step that fails, so its agents stay queued and say why. Nothing real starts.
  'recipes-failed': async (page) => {
    await gitRepoProject(page)
    if (!(await page.evaluate(() => !!window.patchbayRecipes))) return
    await page.evaluate(async () => {
      const doc = await window.patchbay.getDoc()
      // Only the recipe's nodes, so the picture can show them at a readable size.
      await window.patchbay.dispatch({ op: 'removeNodes', ids: doc.nodes.filter((n) => n.projectId === doc.activeProjectId).map((n) => n.id), at: Date.now() })
      const folder = doc.projects[0].folder
      // A git command that always fails, so the picture shows a failed setup without installing anything.
      const params = { task: 'Add dark mode', branch: 'dark-mode', repo: folder, cwd: folder, worktree: true, runs: { setup: ['git', 'rev-parse', '--verify', 'no-such-branch'] } }
      await window.patchbayRecipes.start({ projectId: doc.activeProjectId, ref: 'built-in:Implement and review', params, at: { x: 0, y: 0 } })
    })
    await page.waitForSelector('[data-setup-hold="failed"]', { timeout: 20000 })
    await sleep(800)
    await fitAll(page)
  },
  // Double-clicks an empty part of an agent window's header, which zooms the canvas to that window.
  'header-zoom': async (page) => {
    await page.waitForSelector('.react-flow__node[data-id="idle"] .unit-head', { timeout: 10000 })
    await sleep(500)
    const spot = await page.evaluate(() => {
      const head = document.querySelector('.react-flow__node[data-id="idle"] .unit-head')
      const r = head.getBoundingClientRect()
      // A point on the header itself, not on its title, badges or buttons.
      for (let x = r.left + r.width * 0.55; x < r.right - 4; x += 4) {
        const hit = document.elementFromPoint(x, r.top + r.height / 2)
        if (hit === head || hit?.classList.contains('cwd')) return { x, y: r.top + r.height / 2 }
      }
      return { x: r.left + r.width * 0.6, y: r.top + r.height / 2 }
    })
    await page.mouse.click(spot.x, spot.y, { count: 2 })
    await sleep(700)
  },
  // Zooms to a header, then Esc, then zooms and double-clicks again: both must return to the view from before.
  'header-zoom-back': async (page) => {
    const zoomShown = () => page.evaluate(() => [...document.querySelectorAll('.dock *')].map((e) => e.textContent).find((t) => /^[0-9]+%$/.test(t || '')))
    const before = await (async () => { await page.waitForSelector('.react-flow__node[data-id="idle"] .unit-head', { timeout: 10000 }); await sleep(500); return zoomShown() })()
    await scenes['header-zoom'](page)
    const zoomed = await zoomShown()
    if (zoomed === before) throw new Error(`Double-click didn't zoom: ${zoomed}`)
    // The double-click leaves the keyboard on the canvas, so Esc is the canvas's, not a terminal's.
    await page.keyboard.press('Escape')
    await sleep(700)
    if ((await zoomShown()) !== before) throw new Error(`Esc didn't go back: ${await zoomShown()} vs ${before}`)
    await scenes['header-zoom'](page)
    await scenes['header-zoom'](page)
    if ((await zoomShown()) !== before) throw new Error(`A second double-click didn't go back: ${await zoomShown()} vs ${before}`)
  },
  team: async (page) => {
    await rightClickCanvas(page)
    await sleep(200)
    await page.click('.menu-panel [data-cmd="spawn-team"]')
    await sleep(200)
    await page.type('[name="task"]', 'Add dark mode to the settings page, with tests')
    await sleep(200)
  },
  maximized: async (page) => {
    await page.click('.react-flow__node[data-id="idle"] [data-tool="maximize"]')
    await sleep(600)
  },
  font: async (page) => {
    // The size is in the ⋯ menu now. Before the change it was a button on the header.
    if (!(await page.$('.react-flow__node[data-id="idle"] [data-tool="more"]'))) for (let i = 0; i < 4; i++) await page.click('.react-flow__node[data-id="idle"] [data-tool="font-larger"]')
    else for (let i = 0; i < 4; i++) await require('./uilib.cjs').headerTool(page, 'idle', 'font-larger')
    await sleep(500)
  },
  'closed-project': async (page) => {
    const tabs = await page.$$('.project-tab')
    await tabs[1].click({ button: 'right' })
    await sleep(200)
    await page.click('.menu-panel [data-cmd="close-project"]')
    await sleep(500)
  },
  'delete-confirm': async (page) => {
    const tabs = await page.$$('.project-tab')
    await tabs[1].click({ button: 'right' })
    await sleep(200)
    await page.click('.menu-panel [data-cmd="delete-project"]')
    await sleep(200)
  },
  'file-menu': async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.menubar-item')].find((b) => b.textContent === 'File').click())
    await sleep(200)
  },
  'view-menu': async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.menubar-item')].find((b) => b.textContent === 'View').click())
    await sleep(200)
  },
  'settings-notifications': async (page) => {
    await page.keyboard.down('Control')
    await page.keyboard.press(',')
    await page.keyboard.up('Control')
    await page.waitForSelector('[data-section="notifications"]')
    await page.click('[data-section="notifications"]')
    await sleep(400)
  },
  'settings-sessions': async (page) => {
    await page.keyboard.down('Control')
    await page.keyboard.press(',')
    await page.keyboard.up('Control')
    await page.waitForSelector('[data-section="sessions"]')
    await page.click('[data-section="sessions"]')
    await sleep(400)
  },
  'settings-agents': async (page) => {
    await page.keyboard.down('Control')
    await page.keyboard.press(',')
    await page.keyboard.up('Control')
    await page.waitForSelector('[data-section="claude"]')
    await page.click('[data-section="claude"]')
    await page.evaluate(() => document.getElementById('permissionMode')?.scrollIntoView({ block: 'end' }))
    await sleep(400)
  },
  'settings-messaging': async (page) => {
    await scenes['settings-agents'](page)
    // The row's help runs below its select, so its whole group goes into view.
    await page.evaluate(() => document.getElementById('claudeNativeMessaging')?.closest('.set-group')?.scrollIntoView({ block: 'end' }))
    await sleep(400)
  },
  // Codex chosen as the default, then turned off: Claude Code stands in, and its switch can't be turned off.
  'settings-agents-off': async (page) => {
    await page.keyboard.down('Control')
    await page.keyboard.press(',')
    await page.keyboard.up('Control')
    await page.waitForSelector('[data-section="claude"]')
    await page.click('[data-section="claude"]')
    await page.waitForSelector('#agent-codex')
    await page.select('#defaultAgent', 'codex')
    await page.click('#agent-codex')
    await page.evaluate(() => document.getElementById('permissionMode')?.scrollIntoView({ block: 'end' }))
    await sleep(400)
  },
  'project-menu': async (page) => {
    const tab = await page.$('.project-tab')
    await tab.click({ button: 'right' })
    await sleep(200)
  },
  // A tab part way through a drag, over the first tab, showing where it would land.
  'project-tab-drag': async (page) => {
    await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('.project-tab')]
      const from = tabs[2]
      const to = tabs[0].getBoundingClientRect()
      window.sceneDrag = new DataTransfer()
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.sceneDrag }))
      window.sceneTo = { x: to.left + 4, y: to.top + 8 }
    })
    await sleep(200)
    await page.evaluate(() => {
      const first = document.querySelector('.project-tab')
      first.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.sceneDrag, clientX: window.sceneTo.x, clientY: window.sceneTo.y }))
    })
    await sleep(300)
  },
  'projects-manager': async (page) => {
    await page.evaluate(() => localStorage.setItem('patchbay.projects.suggestArchiveDays', '30'))
    await page.evaluate(() => [...document.querySelectorAll('.menubar-item')].find((b) => b.textContent === 'File').click())
    await sleep(200)
    await page.click('.menu-panel [data-cmd="manage-projects"]')
    await sleep(1200)
  },
  // Archives "Website" for real, through main, then shows the result and the tabs without it.
  'archive-done': async (page) => {
    await scenes['archive-confirm'](page)
    await page.click('.archive-dialog .btn-solid')
    await sleep(2500)
    const state = await page.evaluate(async () => {
      const doc = await window.patchbay.getDoc()
      const runs = await window.patchbay.getStatuses()
      return { website: doc.projects.find((p) => p.id === 'p2'), tabs: [...document.querySelectorAll('.project-tab')].map((t) => t.textContent), statuses: runs }
    })
    console.log(JSON.stringify(state))
  },
  'archive-confirm': async (page) => {
    const tabs = await page.$$('.project-tab')
    await tabs[1].click({ button: 'right' })
    await sleep(200)
    await page.click('.menu-panel [data-cmd="archive-project"]')
    await sleep(1200)
  },
  note: async () => {},
  'note-edit': async (page) => {
    await page.click('.react-flow__node[data-id="note"] .note-body', { count: 2 })
    await sleep(300)
    // The code menu only exists once notes have a toolbar.
    await page.evaluate(() => document.querySelector('.react-flow__node[data-id="note"] [data-note-tool="code"]')?.click())
    await sleep(200)
  },
  // Draws a stroke for real, so the picture shows the pointer path working as well as saved shapes.
  whiteboard: async (page) => {
    const surface = await page.$('.react-flow__node[data-id="board"] .wb-surface')
    const box = await surface.boundingBox()
    await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.8)
    await page.mouse.down()
    for (let i = 1; i <= 24; i++) await page.mouse.move(box.x + box.width * (0.62 + i * 0.012), box.y + box.height * (0.8 - Math.sin(i / 4) * 0.08))
    await page.mouse.up()
    await sleep(400)
  },
  // Pastes a real screenshot of the sidebar onto the selected board, then circles part of it in red, as someone
  // pointing an agent at a problem would.
  // Selects the API box, so its stretch handle shows, with the fill button on.
  'whiteboard-edit': async (page) => {
    await page.click('.react-flow__node[data-id="board"] [aria-label="Select and move"]')
    const surface = await page.$('.react-flow__node[data-id="board"] .wb-surface')
    const box = await surface.boundingBox()
    const scale = box.width / (await surface.evaluate((el) => el.offsetWidth))
    await page.mouse.click(box.x + 270 * scale, box.y + 150 * scale)
    await sleep(300)
  },
  'whiteboard-picture': async (page) => {
    const shot = await page.screenshot({ clip: { x: 14, y: 160, width: 300, height: 170 }, encoding: 'base64' })
    await page.click('.react-flow__node[data-id="board"] .wb-head .title')
    await page.evaluate(async (b64) => {
      // The page's content policy blocks fetching a data URL, so the bytes are decoded by hand.
      const blob = new Blob([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], { type: 'image/png' })
      const data = new DataTransfer()
      data.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, shot)
    await page.waitForSelector('.react-flow__node[data-id="board"] .wb-svg image')
    await page.click('.react-flow__node[data-id="board"] [aria-label="Ellipse"]')
    await page.click('.react-flow__node[data-id="board"] [aria-label="Red"]')
    const surface = await page.$('.react-flow__node[data-id="board"] .wb-surface')
    const box = await surface.boundingBox()
    const scale = box.width / (await surface.evaluate((el) => el.offsetWidth))
    const to = (x, y) => [box.x + x * scale, box.y + y * scale]
    const picture = await page.evaluate(() => window.patchbay.getDoc().then((d) => d.nodes.find((n) => n.id === 'board').shapes.find((s) => s.type === 'image')))
    const [x1, y1] = [picture.x + 10, picture.y + 40]
    const [x2, y2] = [picture.x + picture.width - 10, picture.y + 100]
    await page.mouse.move(...to(x1, y1))
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(...to(x1 + ((x2 - x1) * i) / 10, y1 + ((y2 - y1) * i) / 10))
    await page.mouse.up()
    await page.click('.react-flow__node[data-id="board"] [aria-label="Text"]')
    await page.mouse.click(...to(x2 + 20, y1 + 20))
    await page.keyboard.type('Why is this one stuck?')
    await page.keyboard.press('Enter')
    await sleep(500)
  },
  // Drag-selects the left half of the diagram with the select tool, then moves it down, leaving it selected.
  'whiteboard-select': async (page) => {
    await page.click('.react-flow__node[data-id="board"] [aria-label="Select and move"]')
    const surface = await page.$('.react-flow__node[data-id="board"] .wb-surface')
    const box = await surface.boundingBox()
    const scale = box.width / (await surface.evaluate((el) => el.offsetWidth))
    const to = (x, y) => [box.x + x * scale, box.y + y * scale]
    const drag = async (from, until) => {
      await page.mouse.move(...to(...from))
      await page.mouse.down()
      for (let i = 1; i <= 12; i++) await page.mouse.move(...to(from[0] + ((until[0] - from[0]) * i) / 12, from[1] + ((until[1] - from[1]) * i) / 12))
      await page.mouse.up()
      await sleep(250)
    }
    await drag([20, 100], [430, 240])
    await drag([40, 150], [40, 270])
    await sleep(300)
  },
  ...require('./searchScenes.cjs').scenes,
  ...require('./terminalProfileScenes.cjs').scenes,
  ...require('./compareScenes.cjs').scenes,
  ...require('./subagentScenes.cjs').scenes,
  ...require('./needsYouScenes.cjs').scenes,
  ...require('./filesScenes.cjs').scenes,
  ...require('./stopScenes.cjs').scenes,
  ...require('./readerScenes.cjs').scenes,
  ...require('./readerPictureScenes.cjs').scenes,
  ...require('./noteSendScenes.cjs').scenes
}

const TICKS = '```'
const noteText = [
  '## Release checklist',
  'Ship **v0.4** once the parser tests pass. Details in [the plan](https://example.com/plan).',
  '',
  '- [x] Fix the login redirect',
  '- [ ] Write parser tests',
  '- [ ] Update `CHANGELOG.md`',
  '',
  TICKS + 'json',
  '{',
  '  "name": "patchbay",',
  '  "version": "0.4.0",',
  '  "private": true,',
  '  "retries": 3,',
  '  "tags": ["canvas", "agents", null]',
  '}',
  TICKS,
  '',
  '> Ask before touching the release branch.'
].join('\n')

/** Changes to the seeded canvas that have to be there before the app opens, such as where the view starts. */
const seeds = {
  // More projects, one long closed and one archived, with a page and a trigger, for the projects pictures.
  projects: (doc) => {
    const day = 24 * 3600_000
    const cwd = doc.projects[0].folder
    doc.projects.push(
      { id: 'p3', name: 'Billing API', folder: cwd, viewport: view, closedAt: Date.now() - 52 * day },
      { id: 'p4', name: 'Hackathon 2025', folder: cwd, viewport: view, closedAt: Date.now() - 200 * day, archivedAt: Date.now() - 120 * day },
      { id: 'p5', name: 'Docs site', folder: cwd, viewport: view }
    )
    doc.nodes.push(
      { id: 'w-page', kind: 'browser', title: 'Preview', x: 40, y: 400, width: 380, height: 220, parentId: null, projectId: 'p2', url: 'http://localhost:5173/' },
      { id: 'w-note', kind: 'sticky', title: 'Note', text: 'Launch checklist', x: 640, y: 400, width: 220, height: 140, parentId: null, projectId: 'p2' },
      { id: 'b-term', kind: 'terminal', title: 'Migrations', x: 0, y: 0, width: 560, height: 300, parentId: null, cwd, projectId: 'p3' },
      { id: 'h-note', kind: 'sticky', title: 'Note', text: 'Ideas', x: 0, y: 0, width: 220, height: 140, parentId: null, projectId: 'p4' }
    )
  },
  'projects-manager': (doc) => seeds.projects(doc),
  'conversation-saved': (doc) => {
    process.env.PB_SCENE_SAVE_AS = require('node:path').join(doc.projects[0].folder, 'release-notes-conversation')
  },
  'archive-confirm': (doc) => seeds.projects(doc),
  'archive-done': (doc) => seeds.projects(doc),
  'project-tab-drag': (doc) => seeds.projects(doc),
  'project-menu': (doc) => seeds.projects(doc),
  'browser-evidence': (doc) => require('../browser/evidenceScene.cjs').seed(doc),
  note: (doc) => {
    Object.assign(doc.nodes.find((n) => n.id === 'note'), { text: noteText, width: 460, height: 520 })
    doc.viewport = { x: -360, y: -680, zoom: 1.1 }
    doc.projects[0].viewport = doc.viewport
  },
  'note-edit': (doc) => seeds.note(doc),
  'whiteboard-select': (doc) => seeds.whiteboard(doc),
  // The same sketch with its boxes filled, for the picture of fills and the stretch handle.
  'whiteboard-edit': (doc) => {
    seeds.whiteboard(doc)
    const tints = { Browser: '#2f6fd633', API: '#2f9e5b33', Auth: '#e8862f33' }
    const shapes = doc.nodes.find((n) => n.id === 'board').shapes
    shapes.forEach((s, i) => {
      const label = shapes[i + 1]
      if (s.type === 'rect' && label?.type === 'text' && tints[label.text]) s.fill = tints[label.text]
    })
  },
  'whiteboard-picture': (doc) => {
    seeds.whiteboard(doc)
    Object.assign(doc.nodes.find((n) => n.id === 'board'), { title: 'Stuck agent', shapes: [] })
  },
  whiteboard: (doc) => {
    doc.nodes = doc.nodes.filter((n) => n.id !== 'note')
    const ink = '#1f1f22'
    const blue = '#2f6fd6'
    const box = (x, label) => [
      { type: 'rect', color: ink, size: 4, x1: x, y1: 120, x2: x + 130, y2: 190 },
      { type: 'text', color: ink, size: 4, x: x + 22, y: 140, text: label }
    ]
    const shapes = [
      { type: 'text', color: blue, size: 8, x: 36, y: 30, text: 'Login flow' },
      ...box(40, 'Browser'),
      ...box(270, 'API'),
      ...box(500, 'Auth'),
      { type: 'arrow', color: ink, size: 4, x1: 176, y1: 155, x2: 262, y2: 155 },
      { type: 'arrow', color: ink, size: 4, x1: 406, y1: 155, x2: 492, y2: 155 },
      { type: 'ellipse', color: '#d64545', size: 4, x1: 480, y1: 100, x2: 650, y2: 210 },
      { type: 'text', color: '#d64545', size: 2, x: 492, y: 222, text: 'Token lost here' },
      { type: 'pen', color: '#2f9e5b', size: 4, points: [60, 300, 90, 285, 120, 300, 150, 315, 180, 300, 210, 285, 240, 300] },
      { type: 'line', color: ink, size: 2, x1: 40, y1: 260, x2: 640, y2: 260 }
    ]
    doc.nodes.push({ id: 'board', kind: 'whiteboard', title: 'Login flow sketch', x: 660, y: 660, width: 700, height: 460, parentId: null, projectId: 'p1', shapes })
    doc.viewport = { x: -360, y: -680, zoom: 1.1 }
    doc.projects[0].viewport = doc.viewport
  },
  ...require('./searchScenes.cjs').seeds,
  ...require('./noteSendScenes.cjs').seeds,
  ...require('./compareScenes.cjs').seeds,
  ...require('./subagentScenes.cjs').seeds,
  ...require('./needsYouScenes.cjs').seeds,
  ...require('./filesScenes.cjs').seeds,
  ...require('./stopScenes.cjs').seeds,
  ...require('./readerScenes.cjs').seeds,
  ...require('./readerPictureScenes.cjs').seeds
}

const launchJsonExample = `{
  // Written the way VS Code writes it, comments and trailing commas included.
  "version": "0.2.0",
  "configurations": [
    { "type": "node", "request": "launch", "name": "Dev server", "program": "\${workspaceFolder}/server.js", "args": ["--port", "3000"], "skipFiles": ["<node_internals>/**"], },
    { "type": "node", "request": "launch", "name": "Worker", "runtimeExecutable": "npm", "runtimeArgs": ["run", "worker"] },
    { "type": "node", "request": "launch", "name": "Build then serve", "program": "server.js", "preLaunchTask": "build" },
    { "type": "chrome", "request": "launch", "name": "Open in Chrome", "url": "http://localhost:3000" },
  ],
  "compounds": [{ "name": "Server and worker", "configurations": ["Dev server", "Worker"] }],
}
`

/** Extra profile files for a scene, by scene name. */
const files = {
  // U2: the last Restart to update couldn't start the installer, so the app started again as it was.
  'update-failed': () => ({ 'update-failed.json': JSON.stringify({ reason: "The update didn't install: No update filepath provided, can't quit and install." }) })
}

// Settings > About, where the update status says why the version is unchanged.
scenes['update-failed'] = async (page) => {
  await page.keyboard.down('Control')
  await page.keyboard.press(',')
  await page.keyboard.up('Control')
  await page.waitForSelector('[data-section="about"]')
  await page.click('[data-section="about"]')
  await page.waitForSelector('[data-update-status]', { timeout: 5000 }).catch(() => {})
  await page.evaluate(() => document.querySelector('[data-settings-updates]')?.scrollIntoView({ block: 'center' }))
  await sleep(400)
}

function prepare(name, cwdRoot) {
  if (!scenes[name]) throw new Error(`No scene called ${name}. There are: ${Object.keys(scenes).join(', ')}`)
  const cwd = fs.mkdtempSync(path.join(cwdRoot ?? os.tmpdir(), 'patchbay-scene-'))
  const fake = path.join(__dirname, 'fake-claude.cjs').replace(/\\/g, '/')
  // For the run configuration pictures: one that runs, a compound, and ones that can't, each saying why.
  fs.mkdirSync(path.join(cwd, '.vscode'))
  fs.writeFileSync(path.join(cwd, '.vscode', 'launch.json'), launchJsonExample)
  const doc = canvas(cwd)
  seeds[name]?.(doc)
  return {
    cwd,
    doc,
    settings: { claudeCommand: `node "${fake}"`, notifications: 'off', sound: 'off' },
    // Other files for the profile, by name, as made-up readings.
    files: files[name]?.() ?? {},
    // Waits for the seeded agents to show their statuses, which takes many seconds on a busy machine.
    ready: (page) => require('./sceneReady.cjs').waitForAgents(page, doc),
    act: scenes[name]
  }
}

module.exports = { prepare, scenes, canvas, rightClickCanvas, seedLinks, showLegend }
Object.assign(scenes, require('./placementScenes.cjs').scenes)
Object.assign(seeds, require('./placementScenes.cjs').seeds)
Object.assign(scenes, require('./fileShelfScenes.cjs').scenes)
Object.assign(seeds, require('./fileShelfScenes.cjs').seeds)
Object.assign(scenes, require('./tidyScenes.cjs').scenes)
Object.assign(seeds, require('./tidyScenes.cjs').seeds)
Object.assign(scenes, require('./uxSettingsScenes.cjs').scenes)
Object.assign(seeds, require('./uxSettingsScenes.cjs').seeds)
Object.assign(scenes, require('./uxPanelScenes.cjs').scenes)
Object.assign(seeds, require('./uxPanelScenes.cjs').seeds)
Object.assign(scenes, require('./canvasUxScenes.cjs').scenes)
Object.assign(seeds, require('./canvasUxScenes.cjs').seeds)
Object.assign(scenes, require('./workflowScenes.cjs').scenes)
Object.assign(scenes, require('./zoomScenes.cjs').scenes)
Object.assign(seeds, require('./zoomScenes.cjs').seeds)
Object.assign(scenes, require('./statusScenes.cjs').scenes)
Object.assign(seeds, require('./statusScenes.cjs').seeds)
Object.assign(scenes, require('./safeAreaScenes.cjs').scenes)
Object.assign(seeds, require('./safeAreaScenes.cjs').seeds)
Object.assign(scenes, require('./resourceScenes.cjs').scenes)
Object.assign(files, require('./resourceScenes.cjs').files)
Object.assign(scenes, require('./sessionSyncScenes.cjs').scenes)
Object.assign(scenes, require('./startScenes.cjs').scenes)
Object.assign(seeds, require('./startScenes.cjs').seeds)
Object.assign(scenes, require('./keyboardScenes.cjs').scenes)
Object.assign(seeds, require('./keyboardScenes.cjs').seeds)
Object.assign(scenes, require('./diagnosticsScenes.cjs').scenes)
Object.assign(scenes, require('./focusScenes.cjs').scenes)
