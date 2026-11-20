'use strict'
// Screenshot scenes for workflows: `node screenshot.js <out.png> --scene workflows` (and workflow-editor,
// workflow-run-idle, workflow-run-failed). Agents are fake-claude.cjs, so no quota is spent; commands are git.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fitAll = async (page) => {
  await page.evaluate(() => [...document.querySelectorAll('[data-cmd="fit-view"]')].find((b) => b.closest('.dock'))?.click())
  await sleep(500)
}

/** Makes the project's folder a git repository with one commit, as each run's worktree needs. */
const gitRepoProject = async (page) => {
  const folder = await page.evaluate(async () => (await window.patchbay.getDoc()).projects[0].folder)
  const { execFileSync } = require('node:child_process')
  const git = (...args) => execFileSync('git', ['-C', folder, '-c', 'user.name=Scene', '-c', 'user.email=scene@example.invalid', ...args], { stdio: 'ignore', windowsHide: true })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'Scene')
}

const rightClickCanvas = (page) => require('./scenes.cjs').rightClickCanvas(page)

const openPicker = async (page) => {
  await rightClickCanvas(page)
  await sleep(200)
  if (!(await page.$('.menu-panel [data-cmd="new-from-recipe"]'))) return false
  await page.click('.menu-panel [data-cmd="new-from-recipe"]')
  await page.waitForSelector('[data-workflow-new]', { timeout: 5000 })
  return true
}

/** Clears the project, so a run's group shows at a readable size. */
const clearProject = (page) =>
  page.evaluate(async () => {
    const doc = await window.patchbay.getDoc()
    await window.patchbay.dispatch({ op: 'removeNodes', ids: doc.nodes.filter((n) => n.projectId === doc.activeProjectId).map((n) => n.id), at: Date.now() })
  })

const scenes = {
  // The recipe picker's Workflows section, with the built-in workflow's run form filled in.
  workflows: async (page) => {
    await gitRepoProject(page)
    if (!(await page.evaluate(() => !!window.patchbayWorkflows))) return
    if (!(await openPicker(page))) return
    try {
      await page.waitForSelector('[data-workflow="Plan, review, build"]', { timeout: 5000 })
    } catch {
      return
    }
    await page.click('[data-workflow="Plan, review, build"]')
    await page.waitForSelector('[data-workflow-start] textarea', { timeout: 5000 })
    await page.type('[data-workflow-start] textarea', 'Add dark mode to the settings page')
    await sleep(500)
  },
  // A workflow that opts out of its own worktree says so plainly in its run form.
  'workflow-no-worktree': async (page) => {
    if (!(await page.evaluate(() => !!window.patchbayWorkflows))) return
    await page.evaluate(async () => {
      const projectId = (await window.patchbay.getDoc()).activeProjectId
      const workflow = {
        schema: 1, name: 'Lint here', worktree: false, inputs: [],
        steps: [{ kind: 'command', key: 'lint', title: 'Lint', run: ['npm', 'run', 'lint'] }]
      }
      await window.patchbayWorkflows.save({ projectId, workflow, where: 'personal', overwrite: true })
    })
    if (!(await openPicker(page))) return
    await page.waitForSelector('[data-workflow="Lint here"]', { timeout: 5000 })
    await page.click('[data-workflow="Lint here"]')
    await page.waitForSelector('[data-workflow-no-worktree]', { timeout: 5000 })
    await sleep(300)
  },
  // The outline editor, building a workflow: an agent, a command and a review, with values picked, not typed.
  'workflow-editor': async (page) => {
    await gitRepoProject(page)
    if (!(await page.evaluate(() => !!window.patchbayWorkflows))) return
    if (!(await openPicker(page))) return
    await page.click('[data-workflow-new]')
    await page.waitForSelector('[data-workflow-editor]', { timeout: 5000 })
    await page.type('[data-workflow-name]', 'Feature')
    await page.click('[data-workflow-add="agent"]')
    await page.type('[data-workflow-prompt]', 'Write a plan for ')
    await page.select('[data-workflow-card="agent"] .workflow-value-picker', '{{in:brief}}')
    await page.click('[data-workflow-add="command"]')
    await page.type('[data-workflow-program]', 'npm')
    await page.click('[data-workflow-add="review"]')
    await sleep(300)
    // Back to the agent step, so its picked value shows as a chip.
    await page.click('[data-workflow-card="review"] .workflow-card-title')
    await page.click('[data-workflow-card="agent"] .workflow-card-title')
    await sleep(400)
  },
  // A run whose agent went idle without a result: the step waits, and the panel offers Remind.
  'workflow-run-idle': async (page) => {
    await gitRepoProject(page)
    if (!(await page.evaluate(() => !!window.patchbayWorkflows))) return
    await clearProject(page)
    await page.evaluate(async () => {
      const doc = await window.patchbayWorkflows.list((await window.patchbay.getDoc()).activeProjectId)
      void doc
      const projectId = (await window.patchbay.getDoc()).activeProjectId
      await window.patchbayWorkflows.start({ projectId, ref: 'built-in:Plan, review, build', inputs: { brief: 'Add dark mode to the settings page' }, at: { x: 0, y: 0 } })
    })
    await page.waitForSelector('[data-workflow-chip="waiting-for-you"]', { timeout: 30000 })
    await page.click('[data-workflow-chip="waiting-for-you"]')
    await page.waitForSelector('[data-workflow-panel]', { timeout: 5000 })
    await fitAll(page)
    await sleep(600)
  },
  // A run at its review step: what it shows, a note, Approve and Request changes.
  'workflow-run-review': async (page) => {
    await gitRepoProject(page)
    if (!(await page.evaluate(() => !!window.patchbayWorkflows))) return
    await clearProject(page)
    await page.evaluate(async () => {
      const projectId = (await window.patchbay.getDoc()).activeProjectId
      const workflow = {
        schema: 1,
        name: 'Release check',
        inputs: [{ key: 'notes', label: 'Release notes', type: 'text' }],
        steps: [
          { kind: 'command', key: 'status', title: 'Working tree clean', run: ['git', 'status', '--short'] },
          { kind: 'review', key: 'ok', title: 'Approve the release', question: 'Do these notes and this tree look ready to ship?', show: [{ input: 'notes' }, { step: 'status', output: 'log' }] },
          { kind: 'command', key: 'tag', title: 'Tag it', run: ['git', 'tag', 'v1.0.0'] }
        ]
      }
      await window.patchbayWorkflows.save({ projectId, workflow, where: 'personal', overwrite: true })
      await window.patchbayWorkflows.start({ projectId, ref: 'personal:Release check', inputs: { notes: 'Dark mode, faster search, and the export fix.' }, at: { x: 0, y: 0 } })
    })
    await page.waitForSelector('[data-workflow-chip="waiting-for-you"]', { timeout: 30000 })
    await page.click('[data-workflow-chip="waiting-for-you"]')
    await page.waitForSelector('[data-workflow-review]', { timeout: 5000 })
    await page.type('[data-workflow-review] textarea', 'Mention the export fix first.')
    await fitAll(page)
    await sleep(600)
  },
  // A run of two commands, the second failing: the run stops there, keeps the first step's result, and offers Retry.
  'workflow-run-failed': async (page) => {
    await gitRepoProject(page)
    if (!(await page.evaluate(() => !!window.patchbayWorkflows))) return
    await clearProject(page)
    await page.evaluate(async () => {
      const projectId = (await window.patchbay.getDoc()).activeProjectId
      const workflow = {
        schema: 1,
        name: 'Check branch',
        inputs: [{ key: 'branch', label: 'Branch to check', type: 'text' }],
        steps: [
          { kind: 'command', key: 'status', title: 'Status', run: ['git', 'status', '--short'] },
          { kind: 'command', key: 'verify', title: 'Branch exists', run: ['git', 'rev-parse', '--verify', '{{in:branch}}'] },
          { kind: 'review', key: 'ok', title: 'Look at it', question: 'Ship it?', show: [{ input: 'branch' }] }
        ]
      }
      await window.patchbayWorkflows.save({ projectId, workflow, where: 'personal', overwrite: true })
      await window.patchbayWorkflows.start({ projectId, ref: 'personal:Check branch', inputs: { branch: 'no-such-branch' }, at: { x: 0, y: 0 } })
    })
    await page.waitForSelector('[data-workflow-chip="failed"]', { timeout: 30000 })
    await page.click('[data-workflow-chip="failed"]')
    await page.waitForSelector('[data-workflow-retry]', { timeout: 5000 })
    await fitAll(page)
    await sleep(600)
  }
}

module.exports = { scenes, seeds: {} }
