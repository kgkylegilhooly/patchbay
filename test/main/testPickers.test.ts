import { expect, test } from 'vitest'
import { inTestMode, pickOrStub, UnstubbedPicker } from '../../src/main/testPickers'

const quiet = { PATCHBAY_QUIET_WINDOW: '1' }
const never = async (): Promise<string | null> => {
  throw new Error('the real dialog was opened')
}

test('outside a test run the real dialog is shown', async () => {
  expect(inTestMode({})).toBe(false)
  expect(await pickOrStub('folder', async () => 'C:\picked', {})).toBe('C:\picked')
  // A stray answer in the person's own environment is ignored outside test runs.
  expect(await pickOrStub('folder', async () => 'C:\picked', { PATCHBAY_TEST_PICK_FOLDER: 'C:\stub' })).toBe('C:\picked')
})

test("in a test run the run's answer is used and the dialog never opens", async () => {
  expect(await pickOrStub('folder', never, { ...quiet, PATCHBAY_TEST_PICK_FOLDER: 'C:\repo' })).toBe('C:\repo')
  expect(await pickOrStub('file', never, { ...quiet, PATCHBAY_TEST_PICK_FILE: 'C:\bin\claude.exe' })).toBe('C:\bin\claude.exe')
  expect(await pickOrStub('save', never, { ...quiet, PATCHBAY_TEST_SAVE_AS: 'C:\out.md' })).toBe('C:\out.md')
  expect(await pickOrStub('save', never, { ...quiet, PB_SCENE_SAVE_AS: 'C:\scene' })).toBe('C:\scene')
  expect(await pickOrStub('folder', never, { ...quiet, PATCHBAY_TEST_PICK_FOLDER: 'cancel' })).toBeNull()
  // Each kind has its own answer: a folder answer doesn't answer a file picker.
  await expect(pickOrStub('file', never, { ...quiet, PATCHBAY_TEST_PICK_FOLDER: 'C:\repo' })).rejects.toBeInstanceOf(UnstubbedPicker)
})

test('a test run with no answer fails loudly instead of opening the dialog', async () => {
  await expect(pickOrStub('folder', never, quiet)).rejects.toThrow(/tried to open the OS folder picker.*PATCHBAY_TEST_PICK_FOLDER/)
})
