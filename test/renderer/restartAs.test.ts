import { expect, test } from 'vitest'
import { restartAsPatch } from '../../src/renderer/restartAs'

test('the patch keeps only a fixed mode and a one-word model, and blank goes back to Settings', () => {
  expect(restartAsPatch('plan', 'sonnet')).toEqual({ startMode: 'plan', model: 'sonnet' })
  expect(restartAsPatch('', '')).toEqual({ startMode: undefined, model: undefined })
  expect(restartAsPatch('bypassPermissions' as never, 'opus --x')).toEqual({ startMode: undefined, model: undefined })
})
