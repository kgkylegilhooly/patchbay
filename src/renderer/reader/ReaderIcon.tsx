/** An open book: a document to read, not a note to type in. */
export function ReaderIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg className="kind-icon kind-icon-reader" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 6.5C10.2 5 7.6 4.5 4 4.7v13.6c3.6-.2 6.2.3 8 1.8 1.8-1.5 4.4-2 8-1.8V4.7c-3.6-.2-6.2.3-8 1.8z" />
      <path d="M12 6.5v13.6" />
    </svg>
  )
}
