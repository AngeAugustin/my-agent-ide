import { createRoot } from 'react-dom/client'
import '@vscode/codicons/dist/codicon.css'
import './styles/app.css'
import './lib/monaco'
import { App } from './App'
import { registerAutocomplete } from './lib/autocomplete'

registerAutocomplete()

// Monaco annule ses délais internes (autocomplétion) en rejetant une promesse « Canceled »
// que rien n'intercepte : ce n'est pas une erreur, on l'ignore pour ne pas polluer la console.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as { name?: string; message?: string } | undefined
  if (reason?.name === 'Canceled' && reason.message === 'Canceled') event.preventDefault()
})

createRoot(document.getElementById('root')!).render(<App />)
