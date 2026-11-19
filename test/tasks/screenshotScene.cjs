'use strict'
// Register only for this screenshot process: node -r ./test/tasks/screenshotScene.cjs screenshot.js <png> --scene tasks
// The screenshot harness owns its throwaway profile/processes. No real agents or app data are used.
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const scenes = require('../acceptance/scenes.cjs')
const prepare = scenes.prepare
scenes.scenes.tasks = async (page) => {
  await page.waitForSelector('[data-cmd="toggle-board"]')
  await page.click('[data-cmd="toggle-board"]')
  await page.waitForSelector('[data-task="task-ready"]')
  // Verify that direct document writes cannot forge human acceptance.
  await page.evaluate(async () => {
    const doc = await window.patchbay.getDoc()
    const tasks = doc.projects[0].tasks
    await window.patchbay.dispatch({ op: 'setTasks', projectId: 'p1', tasks: { ...tasks, tasks: tasks.tasks.map((t) => ({ ...t, state: 'accepted' })) } })
    if ((await window.patchbay.getDoc()).projects[0].tasks.tasks.some((t) => t.state === 'accepted')) throw new Error('Generic document dispatch forged acceptance')
  })
  await page.click('[data-task="task-ready"] button')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-task="task-ready"] button')].some((b) => b.textContent === 'Accept this submission' && !b.disabled))
  await page.evaluate(() => [...document.querySelectorAll('[data-task="task-ready"] button')].find((b) => b.textContent === 'Accept this submission').click())
  await page.waitForFunction(() => document.querySelector('[data-task="task-ready"] .task-state')?.textContent === 'accepted')
  // Keep the final board compact while leaving the acceptance badge and blocked result visible.
  await page.evaluate(() => [...document.querySelectorAll('[data-task="task-ready"] button')].find((b) => b.textContent === 'Hide details').click())
  await page.waitForSelector('[data-task="task-ready"] .task-accepted')
}
scenes.prepare = (name, cwdRoot) => {
  const scene = prepare(name, cwdRoot)
  if (name !== 'tasks') return scene
  const cwd = scene.cwd
  const git = (...args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })
  git('init')
  git('config', 'user.name', 'Screenshot fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  fs.writeFileSync(path.join(cwd, 'README.md'), 'Task outcome screenshot fixture\n')
  git('add', '.')
  git('commit', '-m', 'Screenshot fixture')
  const revision = { revision: git('rev-parse', 'HEAD').trim(), uncommitted: false, fingerprint: createHash('sha256').update('').digest('hex') }
  const startedAt = Date.now()
  const command = 'node --version'
  const output = execFileSync(process.execPath, ['--version'], { cwd, windowsHide: true, encoding: 'utf8' })
  const endedAt = Date.now()
  const outputRef = path.join(cwd, '.git', 'verification.log')
  fs.writeFileSync(outputRef, output)
  const task = { id: 'task-ready', projectId: 'p1', brief: 'Verify the local Node runtime', acceptanceCriteria: ['Node prints its installed version'], assignedSessionIds: ['idle'], cwd, state: 'ready-for-review', requiredChecks: [{ id: 'runtime', command, cwd }], dependsOn: [], createdAt: startedAt, updatedAt: endedAt, submissionId: 'submission', acceptances: [] }
  const blocked = { ...task, id: 'task-blocked', brief: 'Run the parser checks', assignedSessionIds: ['work'], state: 'blocked', requiredChecks: [{ id: 'unit', command: 'npm test', cwd }], submissionId: 'blocked-submission' }
  scene.doc.projects[0].tasks = { tasks: [task, blocked], attempts: [
    { id: 'check', taskId: task.id, sessionId: 'idle', kind: 'command', checkId: 'runtime', command, cwd, startedAt, endedAt, exitCode: 0, status: 'passed', outputRef, revision, endRevision: revision },
    { id: 'submission', taskId: task.id, sessionId: 'idle', kind: 'agent-report', summary: 'The runtime is available. The recorded command printed its version.', startedAt: endedAt, endedAt, revision },
    { id: 'blocked-submission', taskId: blocked.id, sessionId: 'work', kind: 'agent-report', summary: 'Implementation submitted; the required unit check has not run yet.', startedAt: endedAt, endedAt, revision }
  ] }
  return scene
}
