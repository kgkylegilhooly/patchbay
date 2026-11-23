import { ArchiveDialog } from './ArchiveDialog'
import { ArchivedToastView } from './ArchivedToastView'
import { FolderToast, useFolderToast } from './FolderToast'
import type { Commands } from './menus'
import { ProjectsManager } from './ProjectsManager'
import { closeArchive, closeProjects, useProjectsUi } from './projectsUi'
import './projects.css'

/** The projects manager and the archive confirmation, over the canvas, whichever is open, and the toast after an archive. */
export function ProjectsLayer({ commands }: { commands: Commands }): React.JSX.Element | null {
  const manager = useProjectsUi((s) => s.manager)
  const archive = useProjectsUi((s) => s.archive)
  const archived = useProjectsUi((s) => !!s.archived)
  const folderNote = useFolderToast((s) => !!s.note)
  if (!manager && !archive && !archived && !folderNote) return null
  return (
    <>
      {manager && <ProjectsManager commands={commands} onClose={closeProjects} />}
      {archive && <ArchiveDialog key={archive} projectId={archive} onClose={closeArchive} />}
      <ArchivedToastView commands={commands} />
      {!archived && <FolderToast commands={commands} />}
    </>
  )
}
