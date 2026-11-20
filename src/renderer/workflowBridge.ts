import type { WorkflowBridge } from '../shared/workflowBridge'

declare global {
  interface Window {
    patchbayWorkflows: WorkflowBridge
  }
}

/** The workflow picker's, form's, run panel's and editor's calls to main. */
export const workflows: WorkflowBridge = window.patchbayWorkflows
