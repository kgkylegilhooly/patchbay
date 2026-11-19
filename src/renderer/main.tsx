import { createRoot } from 'react-dom/client'
import { App } from './App'
import { loadAgentChoice } from './agentChoice'
import { bridge } from './bridge'
import { watchForSlowTasks } from './slowWatch'
import { connectStore } from './store'
import { connectAgentStops } from './agentStops'

void connectStore()
connectAgentStops()
loadAgentChoice(() => bridge.getSettings())
// Picks up a hand edit of settings.json too.
window.addEventListener('focus', () => loadAgentChoice(() => bridge.getSettings()))
watchForSlowTasks()
createRoot(document.getElementById('root')!).render(<App />)
