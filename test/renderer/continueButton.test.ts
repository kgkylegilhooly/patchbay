import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

// A .tsx file, loaded as shell.test.ts loads Panel, since the tests' tsconfig doesn't compile JSX.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (path: string): Promise<any> => import(path)

test('the button shows for an error stop and not for a limit or no stop', async () => {
  const { ContinueButton } = await load('../../src/renderer/nodes/ContinueButton')
  const stop = (kind: string, holds: string | null) => ({ kind, at: 5, until: null, message: null, holds })
  expect(renderToStaticMarkup(h(ContinueButton, { nodeId: 'a', stop: stop('error', null) }))).toContain('data-cmd="continue-after-stop"')
  expect(renderToStaticMarkup(h(ContinueButton, { nodeId: 'a', stop: stop('usage-limit', 'reset') }))).toBe('')
  expect(renderToStaticMarkup(h(ContinueButton, { nodeId: 'a', stop: undefined }))).toBe('')
})
