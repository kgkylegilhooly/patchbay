'use strict'
// Done means 5, on a throwaway repository, never on this one.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function repo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Acceptance')
  git(dir, 'config', 'user.email', 'acceptance@example.invalid')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'first\n')
  git(dir, 'add', 'file.txt')
  git(dir, 'commit', '-q', '-m', 'first')
}

async function main() {
  const c = L.checker()
  const exe = process.argv.includes('--packaged') ? L.packagedExe : undefined
  const work = L.workDir('dm5')
  const repoDir = path.join(work, 'my repo')
  repo(repoDir)
  const branch = 'feat/with-slash'
  const profile = L.newProfile()
  const app = await L.launch({ profile, exe })
  const { page } = app
  try {
    await page.evaluate(() => window.patchbay.dispatch({
      op: 'addNode',
      node: { id: 'g1', kind: 'group', title: 'Worktree group', x: 20, y: 20, width: 700, height: 300, parentId: null, worktree: null }
    }))
    await page.evaluate((r, b) => window.patchbay.createWorktree('g1', { repo: r, branch: b }), repoDir, branch)
    const wt = (await L.nodeOf(page, 'g1')).worktree
    c.check('DM5: a worktree exists on the new branch', git(wt.path, 'branch', '--show-current') === branch, wt.path)
    await L.waitFor('the branch on the group', () => page.evaluate((b) => document.querySelector('.rack .branch')?.textContent === b, branch), 5000)
    c.check('DM5: the group shows its branch', true)

    // Selecting the group and using the real toolbar button: the new node should start in the worktree.
    await L.fitView(page) // Moves the frame clear of the sessions sidebar, which would take the click.
    await page.click('.rack-head .title')
    await L.sleep(300)
    await page.evaluate(() => document.querySelector('.dock [data-cmd="add"]').click())
    await L.sleep(150)
    await page.evaluate(() => document.querySelector('.dock [data-cmd="new-terminal"]').click())
    const term = await L.waitFor('the terminal in the group', async () => (await L.doc(page)).nodes.find((n) => n.kind === 'terminal'), 5000)
    c.check('DM5: a node opened in the group starts in the worktree', term.parentId === 'g1' && term.cwd === wt.path, term.cwd)

    // The terminal in the group reports the branch from inside the folder.
    await L.sleep(1200)
    await L.submit(page, term.id, 'git branch --show-current; echo branch-check-$((1+1))')
    await L.waitFor('the branch check', async () => (await L.snapshot(page, term.id)).includes('branch-check-2'), 15000)
    c.check('DM5: a session in the group is on the new branch', (await L.screen(page, term.id)).includes(branch), branch)

    // A worktree is a new workspace to Claude, so it asks whether to trust the folder. That answer is
    // the owner's, and it's stored in their ~/.claude.json, so this run never gives it.
    await L.openNode(page, L.claude('c1', wt.path, 24, 420, { parentId: 'g1', prompt: 'Reply with only the word OK.' }))
    await L.fitView(page) // A terminal that's off-screen doesn't draw, so its text can't be read.
    const screenText = async () => (await L.screen(page, 'c1')).join(' ').replace(/\s+/g, ' ')
    await L.waitFor('Claude to start', async () => /Quick safety check/.test(await screenText()) || (await L.statusOf(page, 'c1')) === 'idle', 40000)
    const atDialog = /Quick safety check/.test(await screenText())
    console.log('Claude showed the trust dialog:', atDialog)
    if (atDialog) {
      const st = await L.statusOf(page, 'c1')
      c.check('DM5: at the trust dialog the node honestly says starting', st === 'starting', st)
      c.check('DM5: no prompt has run past the dialog', !(await L.nodeOf(page, 'c1')).transcriptPath)
      c.check("DM5: Claude's process started in the worktree folder", (await screenText()).replace(/ /g, '').includes('feat-with-slash'))
    } else {
      const said = await L.waitFor('the reply', async () => L.transcriptText((await L.nodeOf(page, 'c1')).transcriptPath).includes('OK'), 120000)
      c.check('DM5: the Claude node ran with no dialog', said)
    }
    await page.evaluate(() => document.querySelector('.dock [data-cmd="fit-view"]').click())
    await L.sleep(500)
    console.log('screenshot:', await L.shot(page, 'dm5-worktree'))

    // The real confirmation, drawn where it can be read.
    await page.evaluate(() => [...document.querySelectorAll('.wt-bound .btn')].find((b) => b.textContent === 'Remove worktree…').click())
    await page.waitForSelector('.wt-confirm', { timeout: 3000 })
    console.log('screenshot:', await L.shot(page, 'dm5-remove-confirm'))
    await page.evaluate(() => [...document.querySelectorAll('.wt-confirm .btn')].find((b) => b.textContent === 'Keep').click())

    fs.writeFileSync(path.join(wt.path, 'uncommitted.txt'), 'work in progress\n')
    const refused = await page.evaluate(() => window.patchbay.removeWorktree('g1'))
    c.check('DM5: removal refuses while there are uncommitted changes', !refused.ok && /uncommitted/.test(refused.reason), refused)
    c.check('DM5: the refused removal kept the folder and bound group', fs.existsSync(path.join(wt.path, 'uncommitted.txt')) && !!(await L.nodeOf(page, 'g1')).worktree)
    const status = await L.statusOf(page, 'c1')
    c.check('DM5: the refused removal stopped no session', status !== 'exited', status)

    fs.rmSync(path.join(wt.path, 'uncommitted.txt'))
    const removed = await page.evaluate(() => window.patchbay.removeWorktree('g1'))
    c.check('DM5: a clean worktree is removed, with its sessions stopped first', removed.ok && !fs.existsSync(wt.path), removed)
    c.check('DM5: the branch and group stay, and the group is unbound', git(repoDir, 'branch', '--list', branch).includes('with-slash') && (await L.nodeOf(page, 'g1')).worktree === null)
    c.check('no renderer errors', app.problems.length === 0, app.problems.slice(0, 3))
    c.check('clean quit exits 0', (await app.quit()) === 0)
  } catch (e) {
    c.check('run finished', false, e.message)
    await L.shot(page, 'dm5-failure').catch(() => {})
    await app.forceKill().catch(() => {})
  }
  L.cleanup(profile)
  c.finish()
}
main()
