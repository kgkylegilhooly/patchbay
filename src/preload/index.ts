import { contextBridge, ipcRenderer } from 'electron'
import type { PatchbayBridge } from '../shared/contract'
import { exposeWork } from './work'

/**
 * Every bridge method is one channel named `pb:<method>`:
 * - Requests are ipcRenderer.invoke, so main serves them with ipcMain.handle.
 * - `input`, `resize`, `noteFocus` and `whiteboardRendered` are fire-and-forget, so main serves them with ipcMain.on.
 * - `onDoc`, `onStatus`, `onNodeError`, `onOutput`, `onApprovals` and `onCenterNode` are pushed by main with
 *   webContents.send on the channel of the same name, passing the callback's arguments in order.
 */
function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(`pb:${method}`, ...args) as Promise<T>
}

function listen<A extends unknown[]>(method: string, cb: (...args: A) => void): () => void {
  const channel = `pb:${method}`
  const handler = (_event: unknown, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const bridge: PatchbayBridge = {
  browserAttached: (nodeId, contentsId) => invoke('browserAttached', nodeId, contentsId),
  browserNavigate: (nodeId, address) => invoke('browserNavigate', nodeId, address),
  browserStep: (nodeId, step) => invoke('browserStep', nodeId, step),
  browserPick: (nodeId) => invoke('browserPick', nodeId),
  browserCancelPick: (nodeId) => invoke('browserCancelPick', nodeId),
  getBrowserStates: () => invoke('getBrowserStates'),
  onBrowserState: (cb) => listen('onBrowserState', cb),
  openPortInBrowser: (nodeId, port) => invoke('openPortInBrowser', nodeId, port),
  getDoc: () => invoke('getDoc'),
  dispatch: (op) => invoke('dispatch', op),
  onDoc: (cb) => listen('onDoc', cb),
  getStatuses: () => invoke('getStatuses'),
  onStatus: (cb) => listen('onStatus', cb),
  getErrors: () => invoke('getErrors'),
  onNodeError: (cb) => listen('onNodeError', cb),
  attach: (id) => invoke('attach', id),
  input: (id, data) => ipcRenderer.send('pb:input', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pb:resize', id, cols, rows),
  onOutput: (cb) => listen('onOutput', cb),
  startNode: (id) => invoke('startNode', id),
  restartNode: (id) => invoke('restartNode', id),
  armTrigger: (id, shownSpec) => invoke('armTrigger', id, shownSpec),
  disarmTrigger: (id) => invoke('disarmTrigger', id),
  runTriggerNow: (id) => invoke('runTriggerNow', id),
  readLaunchConfigs: (folder) => invoke('readLaunchConfigs', folder),
  listSshHosts: () => invoke('listSshHosts'),
  createWorktree: (groupId, a) => invoke('createWorktree', groupId, a),
  removeWorktree: (groupId) => invoke('removeWorktree', groupId),
  unbindWorktree: (groupId) => invoke('unbindWorktree', groupId),
  pickFolder: () => invoke('pickFolder'),
  pickProgram: () => invoke('pickProgram'),
  openSettingsFile: () => invoke('openSettingsFile'),
  quitApp: () => invoke('quitApp'),
  stopAllAndQuit: () => invoke('stopAllAndQuit'),
  getHostInfo: () => invoke('getHostInfo'),
  onHostInfo: (cb) => listen('onHostInfo', cb),
  stopHost: () => invoke('stopHost'),
  resolveOtherHost: (choice) => invoke('resolveOtherHost', choice),
  onReattach: (cb) => listen('onReattach', cb),
  testNotification: () => invoke('testNotification'),
  onChime: (cb) => listen('onChime', cb),
  getRuns: () => invoke('getRuns'),
  onRun: (cb) => listen('onRun', cb),
  stopRun: (id) => invoke('stopRun', id),
  getPorts: () => invoke('getPorts'),
  onPorts: (cb) => listen('onPorts', cb),
  openPort: (nodeId, port) => invoke('openPort', nodeId, port),
  getUsage: () => invoke('getUsage'),
  testUsageSource: () => invoke('testUsageSource'),
  hasUsageSecret: () => invoke('hasUsageSecret'),
  setUsageSecret: (header) => invoke('setUsageSecret', header),
  removeUsageSecret: () => invoke('removeUsageSecret'),
  openUsageSignIn: () => invoke('openUsageSignIn'),
  onUsage: (cb) => listen('onUsage', cb),
  getAttention: () => invoke('getAttention'),
  onAttention: (cb) => listen('onAttention', cb),
  markSeen: (id) => ipcRenderer.send('pb:markSeen', id),
  openDataFolder: () => invoke('openDataFolder'),
  getAppInfo: () => invoke('getAppInfo'),
  getSettings: () => invoke('getSettings'),
  saveSettings: (settings) => invoke('saveSettings', settings),
  getApprovals: () => invoke('getApprovals'),
  onApprovals: (cb) => listen('onApprovals', cb),
  answerApproval: (requestId, decision) => invoke('answerApproval', requestId, decision),
  savePastedImage: (bytes, mime) => invoke('savePastedImage', bytes, mime),
  openTerminalLink: (nodeId, target) => invoke('openTerminalLink', nodeId, target),
  resolveTerminalPath: (nodeId, target) => invoke('resolveTerminalPath', nodeId, target),
  revealTerminalPath: (nodeId, target) => invoke('revealTerminalPath', nodeId, target),
  sendToAgent: (nodeId, text) => invoke('sendToAgent', nodeId, text),
  readConversation: (nodeId) => invoke('readConversation', nodeId),
  getUpdateState: () => invoke('getUpdateState'),
  onUpdateState: (cb) => listen('onUpdateState', cb),
  checkForUpdates: () => invoke('checkForUpdates'),
  restartToUpdate: () => invoke('restartToUpdate'),
  reopenClosed: (closedId) => invoke('reopenClosed', closedId),
  readClosedTranscript: (closedId) => invoke('readClosedTranscript', closedId),
  noteFocus: (id) => ipcRenderer.send('pb:noteFocus', id),
  onRenderWhiteboard: (cb) => listen('onRenderWhiteboard', cb),
  whiteboardRendered: (requestId, png) => ipcRenderer.send('pb:whiteboardRendered', requestId, png),
  onCenterNode: (cb) => listen('onCenterNode', cb),
  onMessage: (cb) => listen('onMessage', cb),
  getActivity: () => invoke('getActivity'),
  onActivity: (cb) => listen('onActivity', cb),
  nameWithAi: (id) => invoke('nameWithAi', id)
}

contextBridge.exposeInMainWorld('patchbay', bridge)
exposeWork()
