import { ArchiveDialog } from './ArchiveDialog'
import type { Commands } from './menus'
import { ProjectsManager } from './ProjectsManager'
import { closeArchive, closeProjects, useProjectsUi } from './projectsUi'
import './projects.css'

/** The projects manager and the archive confirmation, over the canvas, whichever is open. */
export function ProjectsLayer({ commands }: { commands: Commands }): React.JSX.Element | null {
  const manager = useProjectsUi((s) => s.manager)
  const archive = useProjectsUi((s) => s.archive)
  if (!manager && !archive) return null
  return (
    <>
      {manager && <ProjectsManager commands={commands} onClose={closeProjects} />}
      {archive && (
        <div className="projects-scrim">
          <ArchiveDialog key={archive} projectId={archive} onClose={closeArchive} />
        </div>
      )}
    </>
  )
}
