import { createRoot } from 'react-dom/client'
import '@vscode/codicons/dist/codicon.css'
import './styles/app.css'
import './lib/monaco'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
