/** One daily copy of the canvas, as File > Restore canvas from lists it. See src/core/persist/canvasHistory.ts. */
export interface CanvasCopy {
  /** The copy's file name, as restore takes it. */
  name: string
  /** The local day it was made, as YYYY-MM-DD. */
  day: string
  savedAt: number
  windows: number
  projects: number
}
