import { createRoot } from 'react-dom/client'
import { App } from './App'
import { loadAgentChoice } from './agentChoice'
import { bridge } from './bridge'
import { watchForSlowTasks } from './slowWatch'
import { connectStore } from './store'
import { connectAgentStops } from './agentStops'
import { noteTriggersPaused } from './triggersPaused'

void connectStore()
connectAgentStops()
// The agent choice, and whether all triggers are paused (F54), from one read.
const readSettings = () => bridge.getSettings().then((s) => (noteTriggersPaused(s), s))
loadAgentChoice(readSettings)
// Picks up a hand edit of settings.json too.
window.addEventListener('focus', () => loadAgentChoice(readSettings))
watchForSlowTasks()
createRoot(document.getElementById('root')!).render(<App />)
