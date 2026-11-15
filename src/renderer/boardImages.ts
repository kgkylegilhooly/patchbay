import { useEffect, useMemo, useState } from 'react'
import type { ImageSource } from '../shared/whiteboard'
import { bridge } from './bridge'

/** Pictures on whiteboards, by file name, loaded from main once and kept while the app runs. Null for a missing one. */
const loaded = new Map<string, string | null>()
const loading = new Map<string, Promise<void>>()

function load(file: string): Promise<void> {
  const known = loading.get(file)
  if (known) return known
  const p = bridge
    .readBoardImage(file)
    .then((data) => void loaded.set(file, data))
    .catch(() => void loaded.set(file, null))
    .finally(() => loading.delete(file))
  loading.set(file, p)
  return p
}

/** Finds the pictures a board shows, drawing it again as each one arrives. */
export function useBoardImages(files: string[]): ImageSource {
  const [arrived, setArrived] = useState(0)
  const key = files.join(',')
  useEffect(() => {
    let live = true
    for (const file of key ? key.split(',') : []) {
      if (!loaded.has(file)) void load(file).then(() => live && setArrived((n) => n + 1))
    }
    return () => {
      live = false
    }
  }, [key])
  return useMemo(() => (file: string) => loaded.get(file) ?? null, [arrived])
}
