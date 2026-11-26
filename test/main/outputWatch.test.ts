import { expect, test } from 'vitest'
import { createNotifier } from '../../src/main/notifier'
import { createOutputWatch } from '../../src/main/outputWatch'

// F41: waiting for "Compiled successfully" or an error in a run means watching it, unless Patchbay watches instead.
test('a phrase is found once in new output, through colours, case and a split between chunks, then forgotten', () => {
  const heard: string[] = []
  const w = createOutputWatch({ found: (id, phrase) => heard.push(`${id}: ${phrase}`) })
  expect(w.watch('run', '  Compiled successfully ')).toEqual({ ok: true, phrase: 'Compiled successfully' })
  w.output('other', 'compiled successfully')
  w.output('run', 'webpack \x1b[32mCompiled succ')
  expect(heard).toEqual([])
  w.output('run', 'essfully\x1b[0m in 2.1s\r\n')
  expect(heard).toEqual(['run: Compiled successfully'])
  w.output('run', 'Compiled successfully again')
  expect(heard).toHaveLength(1)
  expect(w.watching('run')).toBeNull()
})

test('only new output counts, a new phrase replaces the old, and one can be cancelled; a blank phrase is refused', () => {
  const heard: string[] = []
  const w = createOutputWatch({ found: (_id, phrase) => heard.push(phrase) })
  w.watch('t', 'error')
  w.watch('t', 'Listening on')
  expect(w.watching('t')).toBe('Listening on')
  w.output('t', 'error: not this one')
  expect(heard).toEqual([])
  w.cancel('t')
  w.output('t', 'Listening on port 3000')
  expect(heard).toEqual([])
  expect(w.watch('t', '   ')).toMatchObject({ ok: false })
  expect(w.watch('t', 'x'.repeat(201))).toMatchObject({ ok: false })
})

test('the notification says what was printed, and a muted window still gets none', () => {
  const show: string[] = []
  const notifier = createNotifier({ show: (n) => show.push(`${n.title}: ${n.body}`), windowFocused: () => false, titleOf: (id) => id, reveal: () => {}, muted: (id) => id === 'quiet' })
  notifier.printed('npm run dev', 'Compiled successfully')
  notifier.printed('quiet', 'Compiled successfully')
  expect(show).toEqual(['npm run dev: Printed "Compiled successfully".'])
  expect(notifier.unseen()).toEqual(['npm run dev', 'quiet'])
})
