import { useEffect, useState } from 'react'
import { openPalette, toggleTheme, useIde } from '../store/ide'
import { modelLabel, useAi } from '../store/ai'
import { toggleAutocomplete, useAutocomplete } from '../lib/autocomplete'
import { indexSummary, useCodeIndex } from '../store/codeIndex'
import { useLsp } from '../lib/lsp'
import { openSettings } from '../store/ide'
import { monaco } from '../lib/monaco'
import { basename } from '../lib/paths'
import { runCommand } from '../lib/commands'
import { Icon } from './Icon'
import { useDebug } from '../store/debug'
import { useNextEdit } from '../lib/nextEdit'

function useMarkerCounts(): { errors: number; warnings: number } {
  const [counts, setCounts] = useState({ errors: 0, warnings: 0 })
  useEffect(() => {
    const update = () => {
      // Seuls les fichiers réels comptent (pas les modèles temporaires des vues de différences).
      const markers = monaco.editor.getModelMarkers({}).filter((m) => m.resource.scheme === 'file')
      setCounts({
        errors: markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length,
        warnings: markers.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length
      })
    }
    update()
    const sub = monaco.editor.onDidChangeMarkers(update)
    return () => sub.dispose()
  }, [])
  return counts
}

export function StatusBar() {
  const workspace = useIde((s) => s.workspace)
  const cursor = useIde((s) => s.cursor)
  const theme = useIde((s) => s.settings.theme)
  const hasEditor = useIde((s) => !!s.activeId && !s.activeId.startsWith('ide://'))
  const { errors, warnings } = useMarkerCounts()
  const chatModel = useIde((s) => s.settings.ai.models.chat)
  const autocompleteOn = useIde((s) => s.settings.autocomplete)
  const autocompleteModel = useIde((s) => s.settings.ai.models.autocomplete)
  const { pending, lastError } = useAutocomplete()
  const index = useCodeIndex((s) => s.status)
  const lspRunning = useLsp((s) => s.running)
  const lspNames = useLsp((s) => s.servers)
  const indexBusy = index?.state === 'scanning' || index?.state === 'embedding'
  useAi((s) => s.providers) // rafraîchit le libellé quand la liste des modèles change
  const debugSession = useDebug((s) => (s.session && s.session.status !== 'terminated' ? s.session : null))
  const nextEditPending = useNextEdit((s) => s.pending)

  return (
    <footer className={`status-bar${debugSession ? ' debugging' : ''}`}>
      <div className="status-left">
        <button className="status-item" title="Ouvrir un dossier" onClick={() => runCommand('workspace.openFolder')}>
          <Icon name="folder" /> {workspace ? basename(workspace) : 'Aucun dossier'}
        </button>
        {workspace && index && (
          <button
            className={`status-item${index.state === 'error' ? ' status-warning' : ''}`}
            title={
              index.state === 'error'
                ? `Index du code : ${index.error}`
                : `Index du code : ${index.files} fichiers, ${index.chunks} extraits${index.embeddingsEnabled && index.embeddingModel ? `, ${index.embedded} avec embeddings` : ' (recherche par mots-clés)'}`
            }
            onClick={() => openSettings('index')}
          >
            <Icon name={indexBusy ? 'loading' : 'database'} className={indexBusy ? 'codicon-modifier-spin' : undefined} /> {indexSummary(index)}
          </button>
        )}
        <span className="status-item" title="Erreurs et avertissements">
          <Icon name="error" /> {errors} <Icon name="warning" /> {warnings}
        </span>
        {debugSession && (
          <button className="status-item" title="Exécuter et déboguer" onClick={() => runCommand('view.debug')}>
            <Icon name="debug-alt" /> {debugSession.name} — {debugSession.status === 'paused' ? 'en pause' : debugSession.status === 'starting' ? 'démarrage' : 'en cours'}
          </button>
        )}
        {nextEditPending && (
          <span className="status-item" title="Prédiction de la prochaine modification">
            <Icon name="loading" className="codicon-modifier-spin" /> Prédiction…
          </span>
        )}
      </div>
      <div className="status-right">
        {hasEditor && cursor && (
          <>
            <button className="status-item" title="Aller à la ligne" onClick={() => openPalette('line')}>
              Ln {cursor.line}, Col {cursor.column}
              {cursor.selected > 0 && ` (${cursor.selected} sélectionné${cursor.selected > 1 ? 's' : ''})`}
            </button>
            <span className="status-item">{cursor.insertSpaces ? `Espaces : ${cursor.tabSize}` : `Tabulations : ${cursor.tabSize}`}</span>
            <span className="status-item">UTF-8</span>
            <span className="status-item">{cursor.eol}</span>
            <button className="status-item" title="Changer le langage" onClick={() => runCommand('editor.changeLanguage')}>
              {cursor.language}
            </button>
          </>
        )}
        <button
          className={`status-item${lastError && autocompleteOn ? ' status-warning' : ''}`}
          title={
            !autocompleteModel
              ? 'Aucun modèle d’autocomplétion (Paramètres › Modèles et clés API)'
              : lastError && autocompleteOn
                ? `Autocomplétion : ${lastError}`
                : `Autocomplétion ${autocompleteOn ? 'activée' : 'désactivée'} (${autocompleteModel.modelId}) — cliquer pour basculer`
          }
          onClick={toggleAutocomplete}
        >
          <Icon name={pending ? 'loading' : autocompleteOn && autocompleteModel ? 'copilot' : 'circle-slash'} className={pending ? 'codicon-modifier-spin' : undefined} />
          {autocompleteOn ? 'Tab' : 'Tab désactivé'}
        </button>
        <button
          className="status-item"
          title={chatModel ? `Modèle de chat : ${chatModel.modelId} — cliquer pour changer` : 'Configurer un modèle IA'}
          onClick={() => openPalette('models')}
        >
          <Icon name="sparkle" /> {chatModel ? modelLabel(chatModel) : 'Configurer l’IA'}
        </button>
        {Object.keys(lspRunning).length > 0 && (
          <button
            className={`status-item${Object.values(lspRunning).includes('error') ? ' status-warning' : ''}`}
            title={`Serveurs de langage : ${Object.entries(lspRunning)
              .map(([id, st]) => `${lspNames.find((n) => n.id === id)?.name ?? id} (${st === 'running' ? 'actif' : st === 'starting' ? 'démarrage' : 'erreur'})`)
              .join(', ')}`}
            onClick={() => openSettings('lsp')}
          >
            <Icon
              name={Object.values(lspRunning).includes('starting') ? 'loading' : 'symbol-namespace'}
              className={Object.values(lspRunning).includes('starting') ? 'codicon-modifier-spin' : undefined}
            />{' '}
            LSP
          </button>
        )}
        <button className="status-item" title="Basculer le thème" onClick={toggleTheme}>
          <Icon name={theme === 'dark' ? 'color-mode' : 'lightbulb'} />
        </button>
      </div>
    </footer>
  )
}
