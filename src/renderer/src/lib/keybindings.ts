export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

/**
 * Teste si un événement clavier correspond à un raccourci comme « Mod+Shift+P ».
 * « Mod » = Cmd sur macOS, Ctrl ailleurs. Les noms de touches entre crochets
 * (« [Backquote] ») désignent une touche physique, utile pour les claviers AZERTY.
 */
export function matchesKeybinding(e: KeyboardEvent, binding: string, mac = isMac): boolean {
  const parts = binding.split('+')
  const keyPart = parts.pop()!
  const mods = new Set(parts.map((p) => p.toLowerCase()))

  const wantCtrl = mods.has('ctrl') || (!mac && mods.has('mod'))
  const wantMeta = mods.has('cmd') || (mac && mods.has('mod'))
  if (e.ctrlKey !== wantCtrl || e.metaKey !== wantMeta) return false
  if (e.shiftKey !== mods.has('shift') || e.altKey !== mods.has('alt')) return false

  if (keyPart.startsWith('[') && keyPart.endsWith(']')) return e.code === keyPart.slice(1, -1)
  if (keyPart.length === 1 && /[a-z0-9]/i.test(keyPart)) {
    // Compare sur la touche physique pour rester indépendant de la disposition (et de Shift).
    const code = /[0-9]/.test(keyPart) ? `Digit${keyPart}` : `Key${keyPart.toUpperCase()}`
    return e.code === code || e.key.toLowerCase() === keyPart.toLowerCase()
  }
  return e.key.toLowerCase() === keyPart.toLowerCase()
}

/** Formate un raccourci pour l'affichage (« Ctrl+Maj+P » ou « ⌘⇧P »). */
export function formatKeybinding(binding: string, mac = isMac): string {
  const parts = binding.split('+').map((p) => {
    const k = p.startsWith('[') ? p.slice(1, -1) : p
    switch (k.toLowerCase()) {
      case 'mod':
        return mac ? '⌘' : 'Ctrl'
      case 'cmd':
        return '⌘'
      case 'ctrl':
        return mac ? '⌃' : 'Ctrl'
      case 'shift':
        return mac ? '⇧' : 'Maj'
      case 'alt':
        return mac ? '⌥' : 'Alt'
      case 'backquote':
        return '`'
      case 'tab':
        return 'Tab'
      case 'escape':
        return 'Échap'
      default:
        return k.length === 1 ? k.toUpperCase() : k
    }
  })
  return mac ? parts.join('') : parts.join('+')
}
