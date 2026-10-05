import {
  closeAllTabs,
  closeTab,
  closeWorkspace,
  collapseAll,
  cycleTab,
  newUntitled,
  openPalette,
  openSettings,
  pickAndOpenFile,
  pickWorkspace,
  refreshTree,
  revealInExplorer,
  saveAll,
  saveTab,
  saveTabAs,
  showSidebarView,
  startInput,
  targetDirectory,
  toggleSidebar,
  toggleTheme,
  updateSettings,
  useIde,
  ask
} from '../store/ide'
import { killTerminal, newTerminal, toggleTerminalPanel } from '../store/terminals'
import { getActiveEditor } from './activeEditor'
import { startInlineEdit } from './inlineEdit'
import { toggleAutocomplete } from './autocomplete'
import { chatWithSelection, newConversation, toggleChat } from '../store/chat'

export interface Command {
  id: string
  title: string
  category?: string
  keybinding?: string
  /** Raccourci alternatif (par exemple pour les claviers AZERTY). */
  altKeybinding?: string
  when?: () => boolean
  run: () => void | Promise<unknown>
}

const hasWorkspace = () => !!useIde.getState().workspace
const hasActiveTab = () => !!useIde.getState().activeId

function runEditorAction(actionId: string): void {
  const editor = getActiveEditor()
  if (!editor) return
  editor.focus()
  void editor.getAction(actionId)?.run()
}

export const commands: Command[] = [
  { id: 'palette.commands', title: 'Afficher toutes les commandes', keybinding: 'Mod+Shift+P', altKeybinding: 'F1', run: () => openPalette('commands') },
  { id: 'palette.files', title: 'Ouverture rapide de fichier', keybinding: 'Mod+P', run: () => openPalette('files') },
  { id: 'palette.line', title: 'Aller à la ligne…', category: 'Éditeur', keybinding: 'Ctrl+G', when: hasActiveTab, run: () => openPalette('line') },

  { id: 'file.new', title: 'Nouveau fichier sans titre', category: 'Fichier', keybinding: 'Mod+N', run: newUntitled },
  {
    id: 'explorer.newFile',
    title: 'Nouveau fichier dans l’espace de travail',
    category: 'Explorateur',
    when: hasWorkspace,
    run: () => {
      const dir = targetDirectory()
      if (dir) {
        showSidebarView('explorer')
        startInput({ path: dir, mode: 'newFile' })
      }
    }
  },
  {
    id: 'explorer.newFolder',
    title: 'Nouveau dossier',
    category: 'Explorateur',
    when: hasWorkspace,
    run: () => {
      const dir = targetDirectory()
      if (dir) {
        showSidebarView('explorer')
        startInput({ path: dir, mode: 'newFolder' })
      }
    }
  },
  { id: 'file.open', title: 'Ouvrir un fichier…', category: 'Fichier', run: pickAndOpenFile },
  { id: 'workspace.openFolder', title: 'Ouvrir un dossier…', category: 'Fichier', keybinding: 'Mod+O', run: pickWorkspace },
  { id: 'workspace.close', title: 'Fermer le dossier', category: 'Fichier', when: hasWorkspace, run: closeWorkspace },
  { id: 'file.save', title: 'Enregistrer', category: 'Fichier', keybinding: 'Mod+S', when: hasActiveTab, run: () => saveTab() },
  { id: 'file.saveAs', title: 'Enregistrer sous…', category: 'Fichier', keybinding: 'Mod+Shift+S', when: hasActiveTab, run: () => saveTabAs() },
  { id: 'file.saveAll', title: 'Tout enregistrer', category: 'Fichier', keybinding: 'Mod+Alt+S', run: saveAll },

  { id: 'editor.close', title: 'Fermer l’éditeur', category: 'Affichage', keybinding: 'Mod+W', when: hasActiveTab, run: () => closeTab(useIde.getState().activeId!) },
  { id: 'editor.closeAll', title: 'Fermer tous les éditeurs', category: 'Affichage', run: closeAllTabs },
  { id: 'editor.next', title: 'Éditeur suivant', category: 'Affichage', keybinding: 'Ctrl+Tab', altKeybinding: 'Mod+Alt+ArrowRight', run: () => cycleTab(1) },
  { id: 'editor.previous', title: 'Éditeur précédent', category: 'Affichage', keybinding: 'Ctrl+Shift+Tab', altKeybinding: 'Mod+Alt+ArrowLeft', run: () => cycleTab(-1) },
  { id: 'editor.format', title: 'Mettre en forme le document', category: 'Éditeur', keybinding: 'Shift+Alt+F', when: hasActiveTab, run: () => runEditorAction('editor.action.formatDocument') },
  { id: 'editor.find', title: 'Rechercher', category: 'Éditeur', when: hasActiveTab, run: () => runEditorAction('actions.find') },
  { id: 'editor.replace', title: 'Remplacer', category: 'Éditeur', when: hasActiveTab, run: () => runEditorAction('editor.action.startFindReplaceAction') },
  { id: 'editor.toggleComment', title: 'Commenter/décommenter la ligne', category: 'Éditeur', when: hasActiveTab, run: () => runEditorAction('editor.action.commentLine') },
  { id: 'editor.fold', title: 'Tout replier', category: 'Éditeur', when: hasActiveTab, run: () => runEditorAction('editor.foldAll') },
  { id: 'editor.unfold', title: 'Tout déplier', category: 'Éditeur', when: hasActiveTab, run: () => runEditorAction('editor.unfoldAll') },
  { id: 'editor.goToSymbol', title: 'Aller au symbole dans le fichier…', category: 'Éditeur', keybinding: 'Mod+Shift+O', when: hasActiveTab, run: () => runEditorAction('editor.action.quickOutline') },
  { id: 'editor.changeLanguage', title: 'Changer le langage du fichier…', category: 'Éditeur', when: hasActiveTab, run: () => openPalette('commands', '>Langage : ') },
  {
    id: 'editor.wordWrap',
    title: 'Activer/désactiver le retour à la ligne',
    category: 'Affichage',
    keybinding: 'Alt+Z',
    run: () => updateSettings({ wordWrap: !useIde.getState().settings.wordWrap })
  },

  { id: 'view.explorer', title: 'Afficher l’explorateur', category: 'Affichage', keybinding: 'Mod+Shift+E', run: () => showSidebarView('explorer') },
  { id: 'view.search', title: 'Rechercher dans les fichiers', category: 'Affichage', keybinding: 'Mod+Shift+F', run: () => showSidebarView('search') },
  { id: 'view.toggleSidebar', title: 'Afficher/masquer la barre latérale', category: 'Affichage', keybinding: 'Mod+B', run: toggleSidebar },
  { id: 'view.toggleTerminal', title: 'Afficher/masquer le terminal', category: 'Affichage', keybinding: 'Ctrl+[Backquote]', altKeybinding: 'Mod+J', run: toggleTerminalPanel },
  { id: 'view.toggleTheme', title: 'Basculer entre thème clair et sombre', category: 'Préférences', run: toggleTheme },
  { id: 'view.revealActive', title: 'Révéler le fichier actif dans l’explorateur', category: 'Explorateur', when: hasActiveTab, run: () => { showSidebarView('explorer'); void revealInExplorer(useIde.getState().activeId!) } },
  { id: 'explorer.refresh', title: 'Actualiser l’explorateur', category: 'Explorateur', when: hasWorkspace, run: refreshTree },
  { id: 'explorer.collapse', title: 'Réduire tous les dossiers', category: 'Explorateur', when: hasWorkspace, run: collapseAll },

  { id: 'terminal.new', title: 'Nouveau terminal', category: 'Terminal', keybinding: 'Ctrl+Shift+[Backquote]', run: () => newTerminal() },
  { id: 'terminal.kill', title: 'Fermer le terminal actif', category: 'Terminal', run: () => killTerminal() },

  { id: 'settings.open', title: 'Ouvrir les paramètres', category: 'Préférences', keybinding: 'Mod+,', run: () => openSettings() },
  { id: 'chat.toggle', title: 'Ouvrir/fermer le chat (ajoute la sélection)', category: 'IA', keybinding: 'Mod+L', run: () => chatWithSelection(true) },
  { id: 'chat.addSelection', title: 'Ajouter la sélection au chat', category: 'IA', keybinding: 'Mod+Shift+L', when: () => !!getActiveEditor()?.hasTextFocus(), run: () => chatWithSelection(false) },
  { id: 'chat.new', title: 'Nouvelle conversation', category: 'IA', run: newConversation },
  { id: 'chat.close', title: 'Fermer le chat', category: 'IA', run: () => toggleChat(false) },
  {
    id: 'editor.inlineEdit',
    title: 'Modifier avec l’IA (édition en ligne)',
    category: 'IA',
    keybinding: 'Mod+K',
    when: () => !!getActiveEditor()?.hasTextFocus(),
    run: () => startInlineEdit(getActiveEditor())
  },
  { id: 'ai.toggleAutocomplete', title: 'Activer/désactiver l’autocomplétion', category: 'IA', run: toggleAutocomplete },
  {
    id: 'ai.triggerSuggestion',
    title: 'Demander une suggestion d’autocomplétion',
    category: 'IA',
    keybinding: 'Alt+\\',
    when: () => !!getActiveEditor()?.hasTextFocus(),
    run: () => getActiveEditor()?.trigger('ide', 'editor.action.inlineSuggest.trigger', {})
  },
  { id: 'ai.configure', title: 'Configurer les modèles et les clés API', category: 'IA', run: () => openSettings('ai') },
  { id: 'ai.selectChatModel', title: 'Choisir le modèle de chat…', category: 'IA', run: () => openPalette('models') },
  { id: 'help.shortcuts', title: 'Raccourcis clavier', category: 'Aide', run: () => openSettings('shortcuts') },
  {
    id: 'help.about',
    title: 'À propos de My Agent IDE',
    category: 'Aide',
    run: () =>
      ask('My Agent IDE', 'Version 0.1.0 — un IDE propulsé par l’IA où vous apportez vos propres clés API.', [
        { label: 'OK', value: 'ok', primary: true }
      ])
  }
]

export function runCommand(id: string): void {
  const cmd = commands.find((c) => c.id === id)
  if (cmd && (!cmd.when || cmd.when())) void cmd.run()
}
