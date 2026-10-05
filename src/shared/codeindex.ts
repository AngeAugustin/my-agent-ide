// Types de l'index du code partagés avec l'interface.

export type IndexState = 'idle' | 'scanning' | 'embedding' | 'ready' | 'error'

export interface IndexStatus {
  root: string | null
  state: IndexState
  files: number
  chunks: number
  /** Extraits disposant d'un vecteur d'embedding. */
  embedded: number
  /** Modèle d'embeddings utilisé (« fournisseur::modèle »), ou null si la recherche est seulement lexicale. */
  embeddingModel: string | null
  /** Vrai si l'utilisateur a accepté d'envoyer le code au fournisseur d'embeddings pour ce projet. */
  embeddingsEnabled: boolean
  progress?: { done: number; total: number }
  /** Estimation des jetons à envoyer pour calculer les embeddings manquants. */
  pendingTokens: number
  error?: string
  updatedAt?: number
}

export interface SearchHit {
  path: string
  startLine: number
  endLine: number
  text: string
  score: number
}
