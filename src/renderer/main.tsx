import { createRoot } from 'react-dom/client'
import { App } from './App'
import { loadAgentChoice } from './agentChoice'
import { bridge } from './bridge'
import { watchForSlowTasks } from './slowWatch'
import { connectStore } from './store'

void connectStore()
loadAgentChoice(() => bridge.getSettings())
watchForSlowTasks()
createRoot(document.getElementById('root')!).render(<App />)
