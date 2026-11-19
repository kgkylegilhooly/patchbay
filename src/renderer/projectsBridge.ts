import type { ProjectsBridge } from '../shared/projects'

declare global {
  interface Window {
    patchbayProjects: ProjectsBridge
  }
}

/** The projects manager's and the archive confirmation's calls to main. */
export const projectsBridge: ProjectsBridge = window.patchbayProjects
