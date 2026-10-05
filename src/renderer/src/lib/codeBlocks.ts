/** Informations d'un bloc de code Markdown : « ```ts:src/app.ts » → langage « ts », chemin « src/app.ts ». */
export function parseFenceInfo(info: string): { lang: string; path?: string } {
  const trimmed = info.trim()
  if (!trimmed) return { lang: '' }
  const [first, ...rest] = trimmed.split(/\s+/)
  const colon = first.indexOf(':')
  if (colon > 0) return { lang: first.slice(0, colon), path: first.slice(colon + 1) || undefined }
  // Variante « ```ts src/app.ts » ou « ```ts path=src/app.ts ».
  const pathArg = rest.find((r) => /^(path|file)=/.test(r))?.replace(/^(path|file)=/, '') ?? (rest[0] && /[./]/.test(rest[0]) ? rest[0] : undefined)
  return { lang: first, path: pathArg }
}

/**
 * Extrait le code d'une réponse en cours de diffusion : contenu du premier bloc ``` s'il existe
 * (même non terminé), sinon le texte brut.
 */
export function extractCode(text: string): { code: string; complete: boolean } {
  const open = text.match(/(^|\n)```[^\n]*\n/)
  if (!open) {
    // Pas encore de bloc : si le texte commence par ```, on attend la fin de la ligne d'ouverture.
    if (/^\s*```/.test(text)) return { code: '', complete: false }
    return { code: text.replace(/\n$/, ''), complete: true }
  }
  const start = (open.index ?? 0) + open[0].length
  const body = text.slice(start)
  const close = body.search(/(^|\n)```\s*(\n|$)/)
  if (close === -1) {
    // Retire une éventuelle ligne de fermeture partielle en fin de flux.
    return { code: body.replace(/\n`{1,3}$/, '').replace(/\n$/, ''), complete: false }
  }
  return { code: body.slice(0, close), complete: true }
}

/** Indique si un extrait de code contient des marqueurs « code existant inchangé ». */
export function hasElisionMarkers(code: string): boolean {
  return /(\.\.\.|…)\s*(code existant|existing code|reste du|rest of|unchanged|inchangé|autres? (méthodes|fonctions|propriétés))/i.test(code)
}
