import './status.css'
import type { Look } from './status'

/**
 * A look's mark: a dot, ring or square in the tone's colour. `size` makes it smaller for dense rows. The words go in
 * the tooltip and to screen readers, so the mark alone still says something.
 */
export function StatusMark({ look, size, className, title }: { look: Look; size?: number; className?: string; title?: string }): React.JSX.Element {
  const style = size ? ({ '--st-size': `${size}px` } as React.CSSProperties) : undefined
  return (
    <span className={`badge st st-${look.tone}${className ? ` ${className}` : ''}`} data-tone={look.tone} style={style} title={title}>
      <span className="led" aria-hidden="true" />
    </span>
  )
}

/** A look's words, coloured only when they ask for something or say why it stopped. `compact` uses its short words. */
export function StatusText({ look, className, compact, ...data }: { look: Look; className?: string; compact?: boolean } & Record<`data-${string}`, string | undefined>): React.JSX.Element {
  const words = compact && look.short ? look.short : look.label
  return (
    <span className={`badge st-label st-${look.tone}${className ? ` ${className}` : ''}`} data-tone={look.tone} title={look.detail ?? (words !== look.label ? look.label : undefined)} {...data}>
      {words}
    </span>
  )
}

/** Mark and words together, for panels and cards. */
export function StatusPair({ look, size, className }: { look: Look; size?: number; className?: string }): React.JSX.Element {
  return (
    <span className={`st-pair${className ? ` ${className}` : ''}`}>
      <StatusMark look={look} size={size} />
      <StatusText look={look} />
    </span>
  )
}
