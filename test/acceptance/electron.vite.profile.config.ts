// The app's build with React's profiling build and no minifying, for rperf.cjs's React render counts (PB_RP_REACT=1):
//   npx electron-vite build -c test/acceptance/electron.vite.profile.config.ts
// Build again with the plain config afterwards: both write to out/.
import { resolve } from 'node:path'
import { mergeConfig } from 'vite'
import base from '../../electron.vite.config'

const root = resolve(__dirname, '..', '..')

export default {
  ...base,
  renderer: mergeConfig(base.renderer ?? {}, {
    root: resolve(root, 'src/renderer'),
    build: { minify: false, rollupOptions: { input: resolve(root, 'src/renderer/index.html') } },
    resolve: { alias: [{ find: 'react-dom/client', replacement: 'react-dom/profiling' }] }
  })
}
