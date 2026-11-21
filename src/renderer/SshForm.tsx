import { useEffect, useRef, useState } from 'react'
import { sshHostProblem } from '../core/ssh/config'
import { bridge } from './bridge'
import { FormShell } from './shell/FormShell'

/**
 * Picks a host from ~/.ssh/config, or takes one typed in, for a terminal that runs ssh to it. Signing in happens in
 * that terminal, as it would in any other.
 */
export function SshForm({ onCancel, onOpen }: { onCancel: () => void; onOpen: (fields: { host: string; home: string }) => void }): React.JSX.Element {
  const [listing, setListing] = useState<{ hosts: string[]; home: string; installed: boolean } | null>(null)
  const [host, setHost] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void bridge.listSshHosts().then(setListing)
    inputRef.current?.focus()
  }, [])

  const typed = host.trim()
  const problem = typed ? sshHostProblem(typed) : null
  const ready = !!listing?.installed && !!typed && !problem

  return (
    <FormShell
      title="SSH to host"
      icon="server"
      className="pop-terminal pop-ssh"
      onCancel={onCancel}
      blocked={!ready}
      submitLabel="Start SSH session"
      onSubmit={() => listing && onOpen({ host: typed, home: listing.home })}
    >
      <label className="field">
        <span className="field-label">Host</span>
        <input ref={inputRef} name="sshHost" placeholder="host or user@host" spellCheck={false} autoComplete="off" value={host} onChange={(e) => setHost(e.target.value)} />
      </label>
      {problem && <p className="field-problem">{problem}</p>}
      {listing && !listing.installed && <p className="field-problem">ssh isn’t installed. Turn on Windows’ OpenSSH Client under Settings &gt; System &gt; Optional features.</p>}
      {listing && listing.hosts.length > 0 && (
        <ul className="launch-list" role="listbox" aria-label="Hosts in your ssh config">
          {listing.hosts.map((h) => (
            <li key={h}>
              <button type="button" className={`ssh-host${h === typed ? ' ssh-host-on' : ''}`} data-ssh-host={h} role="option" aria-selected={h === typed} onClick={() => setHost(h)} onDoubleClick={() => listing.installed && onOpen({ host: h, home: listing.home })}>
                {h}
              </button>
            </li>
          ))}
        </ul>
      )}
      {listing && listing.hosts.length === 0 && <p className="pop-note">No hosts named in ~/.ssh/config. Type one above.</p>}
      <p className="pop-note">Opens a terminal running ssh. Sign in there. Patchbay doesn’t show the status of agents on the host.</p>
    </FormShell>
  )
}
