import { Panel } from './shell/Panel'

/** A conversation to read, not to answer: closed sessions' transcripts and subagents' transcripts. */
export function TranscriptViewer({
  title,
  label,
  text,
  missing,
  onClose,
  className
}: {
  title: string
  label: string
  text: string | null
  missing: string | null
  onClose: () => void
  className?: string
}): React.JSX.Element {
  return (
    <Panel kind="drawer" title={title} label={label} className={className ? `viewer ${className}` : 'viewer shell-beside'} closeLabel="Close transcript" onClose={onClose} initialFocus="none" flush>
      {missing ? (
        <p className="drawer-empty">{missing}</p>
      ) : (
        <pre className="viewer-text" tabIndex={0}>
          {text ?? 'Loading the transcript…'}
        </pre>
      )}
    </Panel>
  )
}
