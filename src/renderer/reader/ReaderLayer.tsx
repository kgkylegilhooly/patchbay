import { useReactFlow } from '@xyflow/react'
import { useEffect } from 'react'
import { isDocPath } from '../../shared/reader'
import { docsBridge } from './readerBridge'
import { openDocument, say, useReaderUi } from './readerUi'

const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')

/** Over the canvas itself, not over a window on it, which may take a drop of its own (a whiteboard takes pictures). */
const overCanvas = (target: EventTarget | null): boolean => {
  const el = target instanceof Element ? target : null
  return !!el?.closest('.react-flow') && !el.closest('.react-flow__node')
}

/**
 * Markdown files dropped on the canvas open in readers where they land, and reader actions that have nowhere else to
 * speak, such as menu items, say what went wrong here.
 */
export function ReaderLayer(): React.JSX.Element | null {
  const flow = useReactFlow()
  const notice = useReaderUi((s) => s.notice)

  useEffect(() => {
    const over = (e: DragEvent): void => {
      if (!hasFiles(e) || !overCanvas(e.target)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e) || !overCanvas(e.target) || e.defaultPrevented) return
      e.preventDefault()
      const files = [...(e.dataTransfer?.files ?? [])]
      const paths = files.map((f) => docsBridge().pathOfFile(f)).filter((p) => p && isDocPath(p))
      if (!paths.length) {
        say(files.length ? 'Only Markdown and text files open in a reader.' : null)
        return
      }
      const at = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      void (async () => {
        for (const [i, path] of paths.entries()) {
          const r = await openDocument(path, { at: { x: at.x + i * 40, y: at.y + i * 40 } })
          if (!r.ok) return say(r.reason)
        }
        say(null)
      })()
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [flow])

  useEffect(() => {
    if (!notice?.ok) return
    const timer = setTimeout(() => say(null), 5000)
    return () => clearTimeout(timer)
  }, [notice])

  if (!notice) return null
  return (
    <div className={notice.ok ? 'reader-notice' : 'reader-notice reader-notice-bad'} role="status">
      <span>{notice.text}</span>
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => say(null)}>
        ×
      </button>
    </div>
  )
}
