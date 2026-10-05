import { useEffect, useState } from 'react'
import { openPalette, toggleTheme, useIde } from '../store/ide'
import { monaco } from '../lib/monaco'
import { basename } from '../lib/paths'
import { runCommand } from '../lib/commands'
import { Icon } from './Icon'

function useMarkerCounts(): { errors: number; warnings: number } {
  const [counts, setCounts] = useState({ errors: 0, warnings: 0 })
  useEffect(() => {
    const update = () => {
      const markers = monaco.editor.getModelMarkers({})
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

  return (
    <footer className="status-bar">
      <div className="status-left">
        <button className="status-item" title="Ouvrir un dossier" onClick={() => runCommand('workspace.openFolder')}>
          <Icon name="folder" /> {workspace ? basename(workspace) : 'Aucun dossier'}
        </button>
        <span className="status-item" title="Erreurs et avertissements">
          <Icon name="error" /> {errors} <Icon name="warning" /> {warnings}
        </span>
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
        <button className="status-item" title="Basculer le thème" onClick={toggleTheme}>
          <Icon name={theme === 'dark' ? 'color-mode' : 'lightbulb'} />
        </button>
      </div>
    </footer>
  )
}
