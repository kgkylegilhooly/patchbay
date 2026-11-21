import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// node-pty is a native module: it stays external so it loads from node_modules
// (or app.asar.unpacked once packaged) rather than being bundled.
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // original-fs is Electron's own fs without its app.asar handling, so it's there at run time, not to bundle.
        external: ['node-pty', 'original-fs'],
        // The session host runs as its own process, under Electron's Node, and must never import electron.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          sessionHost: resolve(__dirname, 'src/main/sessions/hostProcess.ts'),
          hostLauncher: resolve(__dirname, 'src/main/sessions/hostLauncher.ts'),
          // Search reads and indexes transcripts in a worker thread, off the main thread. It must never import electron.
          searchWorker: resolve(__dirname, 'src/main/search/worker.ts'),
          // Programs such as git start from a worker thread, so creating a process never holds up the main thread.
          procWorker: resolve(__dirname, 'src/main/proc/worker.ts')
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      // electron-vite leaves the window's code unminified, which made it about 2 MB to read at every launch.
      minify: true,
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    },
    plugins: [react()]
  }
})
