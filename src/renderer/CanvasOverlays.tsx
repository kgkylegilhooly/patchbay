import { memo } from 'react'
import { Board } from './Board'
import { CompareLayer } from './CompareLayer'
import { FileShelfLayer } from './FileShelf'
import { FocusView } from './FocusView'
import { GitPanel } from './GitPanel'
import { NeedsYouLayer } from './NeedsYouLayer'
import { ProjectsLayer } from './ProjectsLayer'
import { ReaderLayer } from './reader/ReaderLayer'
import { RecipeLayer } from './RecipeLayer'
import { ResourceNotice } from './resources/ResourceNotice'
import { ReviewInboxLayer } from './ReviewInbox'
import { SearchLayer } from './SearchLayer'
import { SendToAgentsLayer } from './SendManyBox'
import { NotifyWhenLayer } from './NotifyWhenBox'
import { ConfirmHost } from './shell/Confirm'
import { DiagnosticsToast } from './diagnostics/AboutDiagnostics'
import { SubagentLayer } from './subagents/SubagentLayer'
import { TerminalParkingWatcher } from './TerminalParkingWatcher'
import { TidyLayer } from './TidyLayer'
import type { Commands } from './menus'
import { HeaderZoomWatcher } from './useHeaderZoom'
import { WorkflowLayer } from './workflows/WorkflowLayer'
import { ZoomTierWatcher } from './ZoomTierWatcher'

/**
 * The canvas owns the nodes React Flow draws, so it renders again on every frame of a drag. Everything drawn over the
 * canvas sits behind these two memo boundaries instead, and none of it is given the nodes, so a drag renders none of it:
 * each part still renders on its own when what it reads from the stores changes.
 *
 * So a layer here must subscribe to everything it shows (a store, React Flow's store, an event). One that reads
 * getState(), the window's size or the page during render is no longer refreshed by the canvas rendering around it.
 */
export const CanvasOverlays = memo(function CanvasOverlays({ commands, selected, boardOpen, gitOpen }: { commands: Commands; selected: string[]; boardOpen: boolean; gitOpen: boolean }) {
  return (
    <>
      <SearchLayer />
      <RecipeLayer selected={selected} />
      <SendToAgentsLayer />
      <NotifyWhenLayer />
      <CompareLayer />
      <WorkflowLayer />
      <ProjectsLayer commands={commands} />
      <NeedsYouLayer commands={commands} />
      <ReaderLayer />
      <HeaderZoomWatcher />
      <ZoomTierWatcher />
      <TerminalParkingWatcher />
      <ResourceNotice commands={commands} />
      <FocusView />
      {boardOpen && <Board commands={commands} />}
      {gitOpen && <GitPanel selected={selected} />}
      <ReviewInboxLayer />
      <FileShelfLayer />
      <DiagnosticsToast />
      <ConfirmHost />
    </>
  )
})

/** The layers drawn inside React Flow, in the canvas's own coordinates. */
export const FlowLayers = memo(function FlowLayers({ sidebar }: { sidebar: boolean }) {
  return (
    <>
      <SubagentLayer />
      <TidyLayer sidebar={sidebar} />
    </>
  )
})
