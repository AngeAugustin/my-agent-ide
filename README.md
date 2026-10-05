# My Agent IDE

Un éditeur de code de bureau propulsé par l’IA, inspiré de Cursor, où **vous apportez vos propres clés API** (Anthropic, OpenAI, Gemini, Mistral, DeepSeek, OpenRouter, Ollama…).

> État : **phase 1 — fondations de l’éditeur**. Les fonctions IA arrivent dans les phases suivantes (voir la feuille de route).

## Fonctionnalités actuelles

- **Éditeur Monaco** (le moteur de VS Code) : coloration de plus de 80 langages, multi-curseurs, rechercher/remplacer, repli de code, minimap, défilement collant, colorisation des parenthèses, mise en forme (JS/TS/JSON/CSS/HTML).
- **Onglets** : aperçu (italique) et onglets épinglés, glisser-déposer pour réordonner, indicateur de fichier modifié, fil d’Ariane, fichiers « Sans titre » avec « Enregistrer sous ».
- **Explorateur de fichiers** : création (y compris `dossier/fichier.ts`), renommage (F2), suppression vers la corbeille, glisser-déposer pour déplacer, menu contextuel, rafraîchissement automatique quand les fichiers changent sur le disque.
- **Ouverture rapide** (`Ctrl+P`) avec recherche floue, **palette de commandes** (`Ctrl+Maj+P`), **aller à la ligne** (`Ctrl+G`).
- **Recherche dans les fichiers** (`Ctrl+Maj+F`) : casse, mot entier, expressions régulières, filtres d’inclusion/exclusion, remplacement global.
- **Terminal intégré** (`Ctrl+J` ou ``Ctrl+` ``) : plusieurs terminaux, vrai shell (node-pty), redimensionnable.
- **Paramètres** (`Ctrl+,`) : thème clair/sombre, police, tabulations, retour à la ligne, minimap, enregistrement automatique, shell, dossiers exclus, liste des raccourcis.
- **Session restaurée** au démarrage (dossier et fichiers ouverts), dossiers récents, confirmation avant de fermer des fichiers non enregistrés.
- Interface entièrement **en français**.

## Prérequis

- Node.js 20 ou plus récent
- Outils de compilation pour le module natif `node-pty` :
  - **Windows** : « Desktop development with C++ » de Visual Studio Build Tools
  - **macOS** : `xcode-select --install`
  - **Linux** : `build-essential` et `python3`

## Démarrage

```bash
npm install
npm run dev        # lance l’application en mode développement (rechargement à chaud)
```

Autres scripts :

| Commande | Rôle |
| --- | --- |
| `npm run build` | compile l’application dans `out/` |
| `npm start` | lance la version compilée |
| `npm run typecheck` | vérifie les types TypeScript |
| `npm test` | lance les tests unitaires (Vitest) |
| `npm run dist` | crée un installateur (Windows, macOS ou Linux) dans `release/` |

> `node-pty` utilise N-API : le même binaire fonctionne avec Node et Electron. En cas d’erreur de chargement du module, lancez `npm run rebuild`.

## Architecture

```
src/
├── main/        Processus principal Electron (fichiers, recherche, terminal, menu, persistance)
├── preload/     Pont sécurisé (contextBridge) exposant `window.api` à l’interface
├── shared/      Types partagés (API IPC, paramètres, session)
└── renderer/    Interface React
    └── src/
        ├── components/   Explorateur, onglets, éditeur, terminal, palette, paramètres…
        ├── store/        État global (Zustand) : espace de travail, onglets, terminaux
        └── lib/          Monaco, commandes et raccourcis, recherche floue, chemins
tests/           Tests unitaires
```

Sécurité : `contextIsolation` et `sandbox` sont activés, `nodeIntegration` est désactivé ; l’interface n’accède au système que par l’API explicite du preload.

## Feuille de route

1. ✅ **Fondations** : éditeur, explorateur, onglets, terminal, palette, recherche, paramètres
2. **Clés API (BYOK)** : gestionnaire de clés chiffrées, couche multi-fournisseurs, choix des modèles
3. **Chat IA** (`Ctrl+L`) avec contexte `@fichier` / `@dossier` / `@code`, et **édition en ligne** (`Ctrl+K`)
4. **Autocomplétion IA** (Tab)
5. **Mode Agent** : modifications multi-fichiers, exécution de commandes, points de restauration
6. **Indexation du code** et recherche sémantique `@codebase`
7. **Finitions** : Git, serveurs de langage (LSP), serveurs MCP, règles de projet, installateurs
