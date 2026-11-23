/**
 * The OS file pickers (choose a folder, a program, a document, where to save) open in front of everything, and the
 * off-screen test and screenshot runs share a desktop with the person. So in those runs (PATCHBAY_QUIET_WINDOW=1, set
 * by test/acceptance/lib.cjs and screenshot.js) a picker never opens: the run's own answer is used, and a run that
 * gave none fails loudly instead of showing the dialog. Outside test mode these do nothing.
 *
 *   PATCHBAY_TEST_PICK_FOLDER   a folder picker's answer
 *   PATCHBAY_TEST_PICK_FILE     a file picker's answer (a program or a document)
 *   PATCHBAY_TEST_SAVE_AS       a save picker's answer (PB_SCENE_SAVE_AS, the older name, still works)
 *   "cancel" as any of these answers as if the person cancelled.
 */
export type PickerKind = 'folder' | 'file' | 'save'

const VARS: Record<PickerKind, string[]> = {
  folder: ['PATCHBAY_TEST_PICK_FOLDER'],
  file: ['PATCHBAY_TEST_PICK_FILE'],
  save: ['PATCHBAY_TEST_SAVE_AS', 'PB_SCENE_SAVE_AS']
}

export function inTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PATCHBAY_QUIET_WINDOW === '1'
}

/** Thrown when a test run reaches a picker it gave no answer for. */
export class UnstubbedPicker extends Error {
  constructor(kind: PickerKind) {
    super(`A test run tried to open the OS ${kind} picker, which would appear in front of the person. Set ${VARS[kind][0]} (a path, or "cancel") for this run.`)
    this.name = 'UnstubbedPicker'
  }
}

/**
 * Runs `show` (the real dialog) only outside test mode. In test mode: the run's answer, null for "cancel", or an
 * UnstubbedPicker error, also written to stderr so it's seen in the run's output.
 */
export async function pickOrStub(kind: PickerKind, show: () => Promise<string | null>, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!inTestMode(env)) return show()
  const answer = VARS[kind].map((v) => env[v]).find((v) => v !== undefined && v !== '')
  if (answer === undefined) {
    const e = new UnstubbedPicker(kind)
    console.error(e.message)
    throw e
  }
  return answer === 'cancel' ? null : answer
}
