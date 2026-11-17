import { createRoot } from 'react-dom/client'
import { App } from './App'
import { watchForSlowTasks } from './slowWatch'
import { connectStore } from './store'

void connectStore()
watchForSlowTasks()
createRoot(document.getElementById('root')!).render(<App />)
