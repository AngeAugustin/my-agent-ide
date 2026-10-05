import type { AiErrorCode } from '@shared/ai'

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AiError'
  }
}

export interface ErrorContext {
  providerName: string
  baseUrl: string
  local?: boolean
}

function codeForStatus(status: number): AiErrorCode {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server'
  if (status >= 400) return 'bad_request'
  return 'unknown'
}

/** Construit une erreur compréhensible à partir d'un statut HTTP et du message du fournisseur. */
export function errorFromStatus(status: number, detail: string, ctx: ErrorContext): AiError {
  const code = codeForStatus(status)
  const suffix = detail ? ` — ${detail}` : ''
  switch (code) {
    case 'auth':
      return new AiError(code, `Clé API refusée par ${ctx.providerName} (vérifiez qu'elle est valide et active)${suffix}`)
    case 'not_found':
      return new AiError(code, `Modèle ou ressource introuvable chez ${ctx.providerName}${suffix}`)
    case 'rate_limit':
      return new AiError(code, `Limite de requêtes ou quota atteint chez ${ctx.providerName}. Réessayez plus tard${suffix}`)
    case 'server':
      return new AiError(code, `${ctx.providerName} est temporairement indisponible (erreur ${status})${suffix}`)
    default:
      return new AiError(code, `Requête refusée par ${ctx.providerName} (erreur ${status})${suffix}`)
  }
}

export function networkError(ctx: ErrorContext, cause?: unknown): AiError {
  const hint = ctx.local
    ? ` Vérifiez que le serveur local est lancé et écoute sur ${ctx.baseUrl}.`
    : ' Vérifiez votre connexion Internet.'
  const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : ''
  return new AiError('network', `Impossible de joindre ${ctx.providerName}.${hint}${detail}`)
}

/** Extrait le message d'un corps d'erreur JSON (formats OpenAI, Anthropic et Google). */
export function extractErrorDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 300) : ''
  const b = body as Record<string, unknown>
  const err = (b.error ?? b) as Record<string, unknown> | string
  if (typeof err === 'string') return err
  if (typeof err?.message === 'string') return err.message
  if (typeof b.message === 'string') return b.message
  return ''
}

/**
 * Normalise n'importe quelle erreur (SDK, fetch, abandon) en AiError.
 * Les SDK Anthropic et OpenAI exposent `status` et `error` sur leurs erreurs d'API.
 */
export function toAiError(err: unknown, ctx: ErrorContext): AiError {
  if (err instanceof AiError) return err
  const e = err as { name?: string; status?: number; error?: unknown; message?: string; cause?: unknown }
  if (e?.name === 'AbortError' || e?.name === 'APIUserAbortError') return new AiError('aborted', 'Requête annulée.')
  if (typeof e?.status === 'number') {
    return errorFromStatus(e.status, extractErrorDetail(e.error) || '', ctx)
  }
  if (e?.name === 'APIConnectionError' || e?.name === 'APIConnectionTimeoutError' || e?.name === 'TypeError') {
    return networkError(ctx, e.cause ?? err)
  }
  return new AiError('unknown', e?.message || String(err))
}
