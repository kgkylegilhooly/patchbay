import { spawn } from 'node:child_process'

/**
 * Starts the host and exits at once, so the host has no living parent. Windows's "end process tree", and
 * anything else that follows parent links from the app, then has no way to reach the sessions.
 * Usage: hostLauncher <host script> ...args. Keep this file free of imports that take time to load.
 */
const [script, ...args] = process.argv.slice(2)
const child = spawn(process.execPath, [script, ...args], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env })
child.once('error', () => process.exit(1))
child.once('spawn', () => {
  child.unref()
  process.exit(0)
})
