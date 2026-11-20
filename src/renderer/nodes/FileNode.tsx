import type { NodeProps } from '@xyflow/react'
import { memo, useEffect } from 'react'
import { fileKind, fileName, folderHint, type FileKind } from '../../shared/fileShelf'
import type { FileNode as FileModel } from '../../shared/model'
import type { FlowNode } from '../flowMapping'
import { checkFiles, openFile, personMade, stateOf, useFilesUi } from '../fileShelfUi'
import { Jacks } from './NodeChrome'
import '../fileShelf.css'

/** One hue per kind of file, so a desktop of them can be told apart at a glance. */
const TINTS: Record<FileKind | 'folder', string> = {
  image: '#49c2c9',
  pdf: '#ff7a6e',
  document: '#7fa8ff',
  sheet: '#62dc8a',
  code: '#c79bf2',
  data: '#e2b04a',
  archive: '#b8a07a',
  media: '#e0689b',
  program: '#a3abbd',
  other: '#98989e',
  folder: '#e2b04a'
}

/** The extension, short enough to print on the page, or nothing. */
function badge(path: string): string {
  const name = fileName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase().slice(0, 4) : ''
}

/** A page with a folded corner and its extension on it, or a folder. */
export function FileGlyph({ path, folder, size = 44 }: { path: string; folder?: boolean; size?: number }): React.JSX.Element {
  const kind = folder ? 'folder' : fileKind(path)
  const tint = TINTS[kind]
  if (folder) {
    return (
      <svg className="file-glyph" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
        <path d="M5 13a3 3 0 0 1 3-3h10l4 4h18a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" fill={`color-mix(in srgb, ${tint} 30%, #1f1f22)`} stroke={tint} strokeWidth="2" />
        <path d="M5 19h38" stroke={tint} strokeWidth="2" />
      </svg>
    )
  }
  const ext = badge(path)
  return (
    <svg className="file-glyph" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path d="M11 4h18l10 10v28a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#2c2c30" stroke={tint} strokeWidth="2" />
      <path d="M29 4v8a2 2 0 0 0 2 2h8" fill="none" stroke={tint} strokeWidth="2" />
      {kind === 'image' ? (
        <path d="M15 34l6-7 5 5 3-3 5 5zM31 22a2 2 0 1 1 0 .01" fill={tint} opacity="0.85" />
      ) : (
        <path d="M15 22h14M15 27h18M15 32h10" stroke={tint} strokeWidth="2" strokeLinecap="round" opacity="0.55" />
      )}
      {ext && (
        <g>
          <rect x="4" y="34" width={Math.max(20, ext.length * 7 + 8)} height="11" rx="2" fill={tint} />
          <text x="8" y="42.6" fontSize="8.5" fontWeight="700" fontFamily="Segoe UI, system-ui, sans-serif" fill="#161618">
            {ext}
          </text>
        </g>
      )}
    </svg>
  )
}

/**
 * A file on the canvas, like an icon on a desktop. Double-click opens it; drag it onto a terminal or agent to type its
 * path there; right-click for the rest. A file that's gone shows as missing, and is looked at again when shown.
 */
export const FileNode = memo(function FileNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node as FileModel
  const state = useFilesUi((s) => stateOf(s.states, node.path))
  const byPerson = personMade(node)
  useEffect(() => checkFiles([{ path: node.path, network: byPerson }]), [node.path, byPerson])
  const missing = state === 'missing'
  return (
    <div
      className={`file-icon${selected ? ' file-icon-selected' : ''}${missing ? ' file-icon-missing' : ''}`}
      data-file-state={state ?? 'checking'}
      title={missing ? `Missing: ${node.path}` : node.path}
      onDoubleClick={() => openFile(node.path)}
    >
      <Jacks />
      <FileGlyph path={node.path} folder={state === 'folder'} />
      <span className="file-icon-name">{node.title}</span>
      <span className="file-icon-hint">{missing ? 'Missing' : folderHint(node.path)}</span>
    </div>
  )
})
