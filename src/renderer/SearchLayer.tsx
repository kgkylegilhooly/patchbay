import { HandoffEditor } from './HandoffEditor'
import { SearchPanel } from './SearchPanel'
import { useSearchUi } from './searchUi'

/** The search drawer and the handoff editor, over the canvas when open. */
export function SearchLayer(): React.JSX.Element {
  const open = useSearchUi((s) => s.open)
  const handoff = useSearchUi((s) => s.handoff)
  return (
    <>
      {open && <SearchPanel />}
      {handoff && <HandoffEditor key={handoff.type === 'node' ? handoff.nodeId : handoff.closedId} source={handoff} />}
    </>
  )
}
