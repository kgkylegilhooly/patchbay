import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

// A .tsx file, loaded as shell.test.ts loads Panel, since the tests' tsconfig doesn't compile JSX.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (path: string): Promise<any> => import(path)

test('the strip shows the summary with Tell it and Dismiss; a node with nothing shows nothing', async () => {
  const { AwayStrip, AwayStripView } = await load('../../src/renderer/nodes/AwayStrip')
  const away = { files: ['lexer.ts', 'parser.ts', 'README.md'], moreFiles: 0, commits: ['086f135 Rework the lexer'], moreCommits: 0, since: 0, shared: [] }
  const html = renderToStaticMarkup(h(AwayStripView, { nodeId: 'a', away }))
  expect(html).toContain('While it was away: 3 files changed, 1 commit.')
  expect(html).toContain('data-cmd="away-tell"')
  expect(html).toContain('data-cmd="away-dismiss"')
  expect(renderToStaticMarkup(h(AwayStrip, { nodeId: 'b' }))).toBe('')
})
