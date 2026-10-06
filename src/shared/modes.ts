// Modes de l'assistant : choisis à chaque message (sélecteur sous la zone de saisie).

import type { ToolName } from './agent'

export type AssistantMode = 'agent' | 'plan' | 'ask' | 'debug'

export const ASSISTANT_MODES: Array<{ id: AssistantMode; label: string; icon: string; description: string }> = [
  { id: 'agent', label: 'Agent', icon: 'hubot', description: 'Explore, modifie le projet et lance des commandes (avec votre accord).' },
  { id: 'plan', label: 'Plan', icon: 'list-ordered', description: 'Analyse le projet sans rien modifier et propose un plan détaillé, à faire exécuter ensuite.' },
  { id: 'ask', label: 'Ask', icon: 'comment-discussion', description: 'Questions et réponses sur votre code, sans outils.' },
  { id: 'debug', label: 'Debug', icon: 'debug-alt', description: 'Reproduit le bug, cherche la cause avec des preuves, corrige puis vérifie.' }
]

/** Outils autorisés en mode Plan : lecture et recherche uniquement. */
export const READ_ONLY_TOOLS: ToolName[] = [
  'list_dir',
  'read_file',
  'search_text',
  'find_files',
  'codebase_search',
  'get_problems',
  'update_todos',
  'web_search',
  'fetch_url',
  'docs_search'
]

/** Un mode qui utilise les outils de l'agent. */
export const usesTools = (mode: AssistantMode) => mode !== 'ask'

/** Normalise une valeur enregistrée (anciennes versions : « chat »). */
export function normalizeMode(value: unknown): AssistantMode {
  return value === 'agent' || value === 'plan' || value === 'ask' || value === 'debug' ? value : value === 'chat' ? 'ask' : 'agent'
}

export const PLAN_INSTRUCTIONS = [
  '<mode>Mode Plan : tu ne modifies rien et ne lances aucune commande. Explore le projet avec les outils de lecture et de recherche pour comprendre ce qui est demandé, puis rédige un plan d’implémentation :',
  '1. Objectif et compréhension de la demande (hypothèses explicites).',
  '2. Fichiers concernés (chemins exacts) et rôle de chacun.',
  '3. Étapes numérotées, concrètes et vérifiables (enregistre-les aussi avec update_todos).',
  '4. Tests et vérifications à effectuer.',
  '5. Risques, alternatives et questions éventuelles pour l’utilisateur.',
  'Le plan sera ensuite exécuté par l’agent : sois précis.</mode>'
].join('\n')

export const DEBUG_INSTRUCTIONS = [
  '<mode>Mode Debug : procède méthodiquement, avec des preuves.',
  '1. Reproduis le problème (run_command, tests, ou lecture de la sortie et de l’état du débogueur joints).',
  '2. Formule des hypothèses sur la cause et vérifie-les une à une (lecture du code, journaux temporaires, exécution) ; ne devine pas.',
  '3. Corrige la cause racine avec la modification minimale, puis relance la reproduction pour prouver que c’est réglé.',
  '4. Retire les journaux temporaires ajoutés et résume : cause, correction, preuve.</mode>'
].join('\n')

export const AGENT_INSTRUCTIONS =
  '<mode>Mode Agent : réalise la demande avec les outils (explorer, modifier, exécuter), vérifie ton travail puis résume les modifications.</mode>'

export const ASK_INSTRUCTIONS = '<mode>Mode Ask : réponds à la question sans modifier le projet.</mode>'

/**
 * Consigne de mode à placer en tête du message : toujours pour Plan et Debug, et pour Agent ou Ask
 * quand le prompt système de la conversation a été écrit pour l'autre usage.
 */
export function modePreamble(mode: AssistantMode, systemFor: 'agent' | 'chat'): string | null {
  if (mode === 'plan') return PLAN_INSTRUCTIONS
  if (mode === 'debug') return DEBUG_INSTRUCTIONS
  if (mode === 'agent' && systemFor === 'chat') return AGENT_INSTRUCTIONS
  if (mode === 'ask' && systemFor === 'agent') return ASK_INSTRUCTIONS
  return null
}
