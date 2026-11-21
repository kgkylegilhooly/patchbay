import { afterEach, describe, expect, it } from 'vitest'
import { askConfirm, cancelAllConfirms, confirmThen, currentConfirm, settleConfirm, subscribeConfirm } from '../../src/renderer/shell/confirmStore'
import { confirmWords } from '../../src/renderer/shell/panelKeys'

afterEach(() => cancelAllConfirms())

describe('askConfirm', () => {
  it('shows the question and resolves true only on the verb', async () => {
    const asked = askConfirm({ title: 'Delete project?', verb: 'Delete project' })
    const shown = currentConfirm()
    expect(shown?.spec.title).toBe('Delete project?')
    settleConfirm(shown!.id, true)
    await expect(asked).resolves.toBe(true)
    expect(currentConfirm()).toBeNull()
  })

  it('resolves false on cancel', async () => {
    const asked = askConfirm({ title: 'Discard?', verb: 'Discard' })
    settleConfirm(currentConfirm()!.id, false)
    await expect(asked).resolves.toBe(false)
  })

  it('queues a second question behind the first, oldest first', async () => {
    const first = askConfirm({ title: 'First?', verb: 'One' })
    const second = askConfirm({ title: 'Second?', verb: 'Two' })
    expect(currentConfirm()?.spec.title).toBe('First?')
    settleConfirm(currentConfirm()!.id, false)
    expect(currentConfirm()?.spec.title).toBe('Second?')
    settleConfirm(currentConfirm()!.id, true)
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
  })

  it('ignores an answer for a question that is no longer showing', async () => {
    const first = askConfirm({ title: 'First?', verb: 'One' })
    const id = currentConfirm()!.id
    settleConfirm(id, false)
    const second = askConfirm({ title: 'Second?', verb: 'Two' })
    // A double click on the first dialog's button must not answer the second.
    settleConfirm(id, true)
    expect(currentConfirm()?.spec.title).toBe('Second?')
    await expect(first).resolves.toBe(false)
    cancelAllConfirms()
    await expect(second).resolves.toBe(false)
  })

  it('gives the same snapshot until the question changes, as useSyncExternalStore needs', () => {
    void askConfirm({ title: 'Same?', verb: 'Yes' })
    expect(currentConfirm()).toBe(currentConfirm())
  })

  it('tells subscribers when the question changes', () => {
    let calls = 0
    const off = subscribeConfirm(() => calls++)
    void askConfirm({ title: 'Tell?', verb: 'Yes' })
    settleConfirm(currentConfirm()!.id, false)
    off()
    void askConfirm({ title: 'Again?', verb: 'Yes' })
    expect(calls).toBe(2)
  })

  it('confirmThen runs only on yes', async () => {
    let ran = 0
    const no = confirmThen({ title: 'Run?', verb: 'Run' }, () => void ran++)
    settleConfirm(currentConfirm()!.id, false)
    await no
    const yes = confirmThen({ title: 'Run?', verb: 'Run' }, () => void ran++)
    settleConfirm(currentConfirm()!.id, true)
    await yes
    expect(ran).toBe(1)
  })
})

describe('confirmWords', () => {
  it('turns a menu label into the question and the verb', () => {
    expect(confirmWords('Delete project…')).toEqual({ title: 'Delete project?', verb: 'Delete project' })
    expect(confirmWords('Remove worktree...')).toEqual({ title: 'Remove worktree?', verb: 'Remove worktree' })
    expect(confirmWords('Close window')).toEqual({ title: 'Close window?', verb: 'Close window' })
  })
})
