import { createRoot } from 'react-dom/client'
import { App } from './App'
import { connectStore } from './store'

void connectStore()
createRoot(document.getElementById('root')!).render(<App />)
