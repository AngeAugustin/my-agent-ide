# My Agent IDE

Un éditeur de code de bureau propulsé par l’IA, inspiré de Cursor, où **vous apportez vos propres clés API** (Anthropic, OpenAI, Gemini, Mistral, DeepSeek, OpenRouter, Ollama…).

> État : **les 7 phases de la feuille de route sont réalisées** (éditeur, clés API, chat, autocomplétion, agent, indexation, finitions).

## Fonctionnalités actuelles

- **Éditeur Monaco** (le moteur de VS Code) : coloration de plus de 80 langages, multi-curseurs, rechercher/remplacer, repli de code, minimap, défilement collant, colorisation des parenthèses, mise en forme (JS/TS/JSON/CSS/HTML).
- **Onglets** : aperçu (italique) et onglets épinglés, glisser-déposer pour réordonner, indicateur de fichier modifié, fil d’Ariane, fichiers « Sans titre » avec « Enregistrer sous ».
- **Explorateur de fichiers** : création (y compris `dossier/fichier.ts`), renommage (F2), suppression vers la corbeille, glisser-déposer pour déplacer, menu contextuel, rafraîchissement automatique quand les fichiers changent sur le disque.
- **Ouverture rapide** (`Ctrl+P`) avec recherche floue, **palette de commandes** (`Ctrl+Maj+P`), **aller à la ligne** (`Ctrl+G`).
- **Recherche dans les fichiers** (`Ctrl+Maj+F`) : casse, mot entier, expressions régulières, filtres d’inclusion/exclusion, remplacement global.
- **Terminal intégré** (`Ctrl+J` ou ``Ctrl+` ``) : plusieurs terminaux, vrai shell (node-pty), redimensionnable.
- **Paramètres** (`Ctrl+,`) : thème clair/sombre, police, tabulations, retour à la ligne, minimap, enregistrement automatique, shell, dossiers exclus, liste des raccourcis.
- **Session restaurée** au démarrage (dossier et fichiers ouverts), dossiers récents, confirmation avant de fermer des fichiers non enregistrés.
- **Vos propres clés API (BYOK)** — Paramètres › *Modèles et clés API* :
  - fournisseurs intégrés : Anthropic, OpenAI, Google Gemini, Mistral, DeepSeek, OpenRouter, Groq, xAI, ainsi qu’Ollama et LM Studio en local (sans clé) ;
  - ajout de n’importe quelle API **compatible OpenAI** (vLLM, Together, proxy d’entreprise…) ;
  - clés **chiffrées par le trousseau du système** (`safeStorage` d’Electron) ; seule une version masquée est affichée, la clé complète ne quitte jamais le processus principal, sauf vers le fournisseur concerné ;
  - test de connexion, chargement de la liste des modèles, URL de base modifiable (proxy, port local) ;
  - **un modèle par usage** : chat, édition en ligne, autocomplétion, agent — avec un bouton « Tester » ;
  - choix rapide du modèle de chat depuis la barre d’état ou la palette (« IA : Choisir le modèle de chat ») ;
  - compteur de jetons consommés par fournisseur.
- **Chat IA** (`Ctrl+L`, panneau de droite) :
  - réponses en flux, rendu Markdown (sans HTML exécutable), coloration du code, résumé de la réflexion du modèle (repliable) ;
  - contexte avec `@` : fichiers, dossiers, **problèmes** de l’éditeur, **diff Git**, sortie du **terminal**, **`@web`** (recherche sur Internet avec la question, puis lecture des premières pages), **page web** (`@https://…`), **documentations** indexées (`@` + nom), état du **débogueur** (`@Débogueur` : pile et variables) ; le fichier actif est joint automatiquement (cliquer sur sa puce pour l’exclure) ; sélection ajoutée avec `Ctrl+L` / `Ctrl+Maj+L` ; images collées (`Ctrl+V`) pour les modèles multimodaux ;
  - sur chaque bloc de code : copier, insérer au curseur, **Appliquer** au fichier indiqué (création ou fusion d’un extrait par le modèle d’édition, puis vue de différences à accepter ou rejeter), coller une commande dans le terminal (sans l’exécuter) ;
  - choix du modèle par conversation, régénération, arrêt, historique des conversations par dossier ;
  - **résumé automatique des longues conversations** (chat et agent, y compris en pleine tâche) : à l’approche de la limite du modèle (seuil réglable), l’historique est remplacé par un résumé structuré rédigé par le modèle ; jauge de remplissage du contexte sous la zone de saisie (clic pour résumer à la demande) et résumé consultable dans la conversation.
- **Édition en ligne** (`Ctrl+K` dans l’éditeur) : décrivez la modification de la sélection (ou le code à générer au curseur) ; la réponse s’écrit directement dans le fichier, puis s’affiche en différences (lignes ajoutées en vert, supprimées barrées) — `Ctrl+Entrée` pour accepter, `Échap` pour rejeter, ou affinez avec une nouvelle instruction. Une seule annulation (`Ctrl+Z`) défait toute la modification.
- **Autocomplétion IA** (texte grisé pendant la frappe) : `Tab` pour accepter, `Ctrl+→` pour accepter mot par mot, `Échap` pour ignorer, `Alt+\` pour en demander une ; activation et délai réglables, indicateur « Tab » dans la barre d’état (clic pour activer/désactiver).
  - point d’API **FIM** natif (remplissage entre le code avant et après le curseur) pour Codestral (Mistral), DeepSeek, Ollama et LM Studio ; sinon, n’importe quel modèle de conversation (par défaut Claude Haiku 4.5 avec Anthropic) ;
  - suggestions nettoyées (pas de Markdown, pas de répétition du code existant), mises en cache : taper le début d’une suggestion ne relance pas de requête, même quand l’éditeur ferme automatiquement une parenthèse.
- **Prédiction de la prochaine modification** (comme « Cursor Tab ») : après une modification, le modèle d’autocomplétion propose la suivante ailleurs dans le fichier (renommage à propager, appel à adapter…), affichée en différences ; `Tab` pour y aller si elle est loin, puis `Tab` pour l’accepter (les prédictions s’enchaînent), `Échap` pour l’ignorer.
- **Mode Agent** (`Ctrl+I`, ou bascule « Agent » dans le chat) : l’agent réalise une tâche en plusieurs étapes avec des outils — explorer (`list_dir`, `find_files`, `search_text`, `read_file`), modifier (`edit_file` par remplacement exact, `write_file`, `delete_file`), exécuter (`run_command`) et lire les problèmes de l’éditeur.
  - chaque action s’affiche en direct (statut, sortie des commandes, `+/−` lignes) ;
  - **commandes soumises à votre accord** (« Exécuter », « Refuser », « Toujours autoriser »), sauf celles de la liste autorisée — une commande avec enchaînement (`;`, `&&`, `|`) ou redirection demande toujours l’accord ; option « tout exécuter » à vos risques ;
  - l’agent ne peut ni sortir du dossier du projet ni toucher à `.git` ;
  - **points de restauration** : chaque demande mémorise l’état des fichiers avant modification ; vue de différences et annulation par fichier, ou « Restaurer ce point » pour tout annuler (l’agent en est informé au message suivant) ;
  - outils web (désactivables) : `web_search`, `fetch_url` et `docs_search` dans vos documentations indexées ;
  - limites réglables (nombre d’étapes, délai des commandes), bouton « Arrêter » à tout moment.
- **Indexation du code** (Paramètres › *Indexation du code*, indicateur dans la barre d’état) :
  - index automatique du projet à l’ouverture, mis à jour quand les fichiers changent ; respecte `.gitignore` (via `git ls-files`) et les dossiers exclus ; découpage en extraits aux limites des déclarations ;
  - **recherche par mots-clés locale** (BM25, aucun envoi réseau) et, si vous l’activez pour le projet, **recherche sémantique** par embeddings (Voyage AI — recommandé par Anthropic —, OpenAI, Gemini, Mistral, Ollama…), combinées par fusion de classements ;
  - rien n’est envoyé au fournisseur d’embeddings sans votre accord explicite par projet (estimation des jetons affichée) ; changement de modèle = vecteurs recalculés ;
  - utilisée par `@codebase` dans le chat, par l’outil `codebase_search` de l’agent et par le mode « sémantique » de la vue Recherche.
- **Web et documentation** (Paramètres › *Web et documentation*) : moteur de recherche au choix — DuckDuckGo (sans clé), Brave Search ou Tavily (clé chiffrée comme les autres) ; **indexation de documentations** : l’IDE parcourt un site à partir d’une adresse (même site, même chemin, nombre de pages limité), en extrait le texte et l’indexe localement pour `@` + nom dans le chat et l’outil `docs_search` de l’agent.
- **Débogueur** (`Ctrl+Maj+D`, menu *Exécuter*) pour **Node.js** (inspecteur V8, sans extension) et **Python** (debugpy) :
  - points d’arrêt dans la marge (`F9`), conditionnels (clic droit), désactivables, mémorisés par projet et qui suivent les lignes modifiées ;
  - `F5` démarrer / continuer, `F10` pas à pas principal, `F11` détaillé, `Maj+F11` sortant, `F6` suspendre, `Maj+F5` arrêter ; barre d’outils flottante ;
  - variables (arborescence dépliable), expressions espionnées, pile des appels (cadres internes masqués), ligne courante surlignée, **console de débogage** avec sortie du programme et évaluation d’expressions dans le contexte en pause ;
  - fichier actif ou configurations `.vscode/launch.json` (types `node` et `python`, variables `${workspaceFolder}`, `${file}`, `${env:…}`…). Python nécessite `pip install debugpy` (l’IDE l’indique).
- **Contrôle de source Git** (`Ctrl+Maj+G`) : fichiers modifiés, indexés, en conflit ; diff par fichier ; indexer, désindexer, annuler ; commit (ou modification du dernier) ; **message de commit rédigé par l’IA** à partir des modifications indexées et du style des commits précédents ; branches (changer, créer) ; pull, push, fetch ; couleurs Git dans l’explorateur et compteur dans la barre d’activité.
- **Serveurs de langage (LSP)** : vérification des types sur tout le projet, autocomplétion intelligente, survol, aller à la définition (`F12`, `Ctrl`+clic), références, renommage (`F2`), corrections rapides, mise en forme.
  - **TypeScript / JavaScript intégré** (aucune installation) ; Python (pyright, basedpyright, pylsp), Go (gopls), Rust (rust-analyzer), C/C++ (clangd) détectés automatiquement s’ils sont installés ;
  - page Paramètres › *Langages* : état, activation par langage, commande d’installation.
- **Serveurs MCP** (Model Context Protocol) pour l’agent : configuration au format Cursor / Claude Desktop (`mcpServers`, commande locale ou URL distante), état et outils de chaque serveur, appels soumis à votre accord (ou autorisés par serveur). Les serveurs déclarés par un projet (`.cursor/mcp.json`, `.mcp.json`) restent désactivés tant que vous ne les autorisez pas, et ne peuvent pas s’auto-approuver.
- **Règles** : vos règles personnelles (Paramètres) et celles du projet — `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`, `.cursor/rules/*.mdc` (en-têtes `description`, `globs`, `alwaysApply`) — sont ajoutées au chat, à l’agent et à l’édition en ligne ; les règles « à la demande » sont proposées à l’agent.
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
| `npm run dist` | crée les installateurs de la plateforme courante dans `release/` |
| `npm run dist:win` / `dist:mac` / `dist:linux` | installateur pour une plateforme précise (`.exe`, `.dmg`, `.AppImage` / `.deb`) |
| `npm run icon` | régénère l’icône `build/icon.png` |

> `node-pty` utilise N-API : le binaire compilé par `npm install` fonctionne tel quel dans Electron (la reconstruction est désactivée dans `electron-builder.yml`).

## Désinstallation

Toutes les données de l’application (paramètres, clés API chiffrées, conversations, index du code, documentations, caches) sont dans un seul dossier : `%APPDATA%\My Agent IDE` (Windows), `~/Library/Application Support/My Agent IDE` (macOS), `~/.config/My Agent IDE` (Linux). Vos projets ne sont jamais touchés.

- **Windows** : *Paramètres › Applications › My Agent IDE › Désinstaller*. Le désinstallateur supprime le programme et ses raccourcis, puis propose d’effacer aussi vos données (réponse par défaut : oui). Une mise à jour conserve les données ; en désinstallation silencieuse (`/S`), elles sont conservées sauf avec l’option `/SUPPRIMERDONNEES`.
- **macOS / Linux** : *Paramètres › Général › Supprimer toutes mes données* efface le dossier et ferme l’application ; mettez ensuite l’application à la corbeille (macOS), supprimez le fichier AppImage, ou `sudo apt remove my-agent-ide` pour le paquet .deb.

## Installateurs et intégration continue

- `.github/workflows/ci.yml` vérifie les types, lance les tests et compile à chaque push.
- `.github/workflows/release.yml` construit les installateurs **Windows (.exe), macOS (.dmg pour puces Apple et pour Mac Intel) et Linux (.AppImage, .deb)** quand vous poussez une étiquette de version, puis crée un brouillon de publication GitHub avec les fichiers :

```bash
git tag v0.1.0
git push --tags
```

Les installateurs ne sont pas signés par défaut (Windows SmartScreen et macOS Gatekeeper afficheront un avertissement). Pour les signer, ajoutez vos certificats dans les secrets du dépôt (`CSC_LINK`, `CSC_KEY_PASSWORD`, et pour macOS `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) et retirez `CSC_IDENTITY_AUTO_DISCOVERY: false`.

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

Couche IA (`src/main/ai/`) : un adaptateur par famille d’API — SDK officiel Anthropic, SDK OpenAI (utilisé aussi pour toutes les API compatibles), API REST de Gemini — derrière une interface commune qui diffuse des événements normalisés (`text`, `reasoning`, `tool_call`, `usage`, `done`, `error`). Les blocs natifs renvoyés par le fournisseur (blocs de réflexion signés, signatures Gemini) sont conservés et renvoyés tels quels pour que les conversations avec outils restent valides. Pour les modèles Claude récents (Opus 5.5, Opus 5, Sonnet 5.5, Fable 5.1), le **repli côté serveur** (`fallbacks: "default"`) est activé : si un filtre de sécurité décline une demande, l’API la relance sur un modèle de secours et l’IDE l’indique.

> Sous Linux sans trousseau (GNOME Keyring, KWallet), Electron ne peut chiffrer les clés qu’avec un mot de passe fixe : l’IDE l’indique par un avertissement.

Sécurité : `contextIsolation` et `sandbox` sont activés, `nodeIntegration` est désactivé ; l’interface n’accède au système que par l’API explicite du preload.

## Feuille de route

1. ✅ **Fondations** : éditeur, explorateur, onglets, terminal, palette, recherche, paramètres
2. ✅ **Clés API (BYOK)** : gestionnaire de clés chiffrées, couche multi-fournisseurs, choix des modèles
3. ✅ **Chat IA** (`Ctrl+L`) avec contexte `@`, application des modifications avec diff, et **édition en ligne** (`Ctrl+K`)
4. ✅ **Autocomplétion IA** (Tab)
5. ✅ **Mode Agent** : modifications multi-fichiers, exécution de commandes, points de restauration
6. ✅ **Indexation du code** et recherche sémantique `@codebase`
7. ✅ **Finitions** : Git, serveurs de langage (LSP), serveurs MCP, règles de projet, installateurs
8. ✅ **Compléments** : `@web` et documentations, résumé des longues conversations, prédiction de la prochaine modification, débogueur Node.js / Python

Non prévu : la compatibilité avec les extensions VS Code (elle nécessiterait de reprendre l’hôte d’extensions de VS Code, donc un fork complet).
