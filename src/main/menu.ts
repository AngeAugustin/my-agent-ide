import { Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'

/** Menu natif en français. Les actions sont relayées à l'interface sous forme de commandes. */
export function buildMenu(getContents: () => WebContents | null): Menu {
  const send = (command: string) => () => getContents()?.send('menu:command', command)
  const isMac = process.platform === 'darwin'

  // Les raccourcis clavier sont gérés par l'interface : les accélérateurs ne servent qu'à l'affichage.
  const item = (label: string, command: string, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    click: send(command),
    accelerator,
    registerAccelerator: false
  })

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Fichier',
      submenu: [
        item('Nouveau fichier…', 'file.new', 'CmdOrCtrl+N'),
        item('Ouvrir un fichier…', 'file.open'),
        item('Ouvrir un dossier…', 'workspace.openFolder', 'CmdOrCtrl+O'),
        { type: 'separator' },
        item('Enregistrer', 'file.save', 'CmdOrCtrl+S'),
        item('Enregistrer tout', 'file.saveAll', 'CmdOrCtrl+Alt+S'),
        { type: 'separator' },
        item('Fermer l’éditeur', 'editor.close', 'CmdOrCtrl+W'),
        item('Fermer le dossier', 'workspace.close'),
        { type: 'separator' },
        item('Paramètres', 'settings.open', 'CmdOrCtrl+,'),
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Fermer la fenêtre' } : { role: 'quit', label: 'Quitter' }
      ]
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' },
        { type: 'separator' },
        item('Rechercher dans les fichiers', 'view.search', 'CmdOrCtrl+Shift+F')
      ]
    },
    {
      label: 'Affichage',
      submenu: [
        item('Palette de commandes…', 'palette.commands', 'CmdOrCtrl+Shift+P'),
        item('Ouverture rapide…', 'palette.files', 'CmdOrCtrl+P'),
        { type: 'separator' },
        item('Explorateur', 'view.explorer', 'CmdOrCtrl+Shift+E'),
        item('Recherche', 'view.search'),
        item('Afficher/masquer la barre latérale', 'view.toggleSidebar', 'CmdOrCtrl+B'),
        item('Afficher/masquer le terminal', 'view.toggleTerminal', 'Ctrl+`'),
        { type: 'separator' },
        item('Changer de thème', 'view.toggleTheme'),
        { type: 'separator' },
        { role: 'zoomIn', label: 'Zoom avant' },
        { role: 'zoomOut', label: 'Zoom arrière' },
        { role: 'resetZoom', label: 'Taille réelle' },
        { role: 'togglefullscreen', label: 'Plein écran' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Outils de développement' }
      ]
    },
    {
      label: 'Terminal',
      submenu: [item('Nouveau terminal', 'terminal.new', 'Ctrl+Shift+`'), item('Fermer le terminal', 'terminal.kill')]
    },
    {
      label: 'Aide',
      submenu: [
        item('Raccourcis clavier', 'help.shortcuts'),
        item('À propos de My Agent IDE', 'help.about')
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}
