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
    <div className={className ? `viewer ${className}` : 'viewer'} role="dialog" aria-label={label}>
      <header className="drawer-head">
        <h2>{title}</h2>
        <button className="icon-btn" aria-label="Close transcript" onClick={onClose}>
          ×
        </button>
      </header>
      {missing ? (
        <p className="drawer-empty">{missing}</p>
      ) : (
        <pre className="viewer-text" tabIndex={0}>
          {text ?? 'Loading the transcript…'}
        </pre>
      )}
    </div>
  )
}
