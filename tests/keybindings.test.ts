import { describe, expect, it } from 'vitest'
import { formatKeybinding, matchesKeybinding } from '../src/renderer/src/lib/keybindings'

function key(init: Partial<KeyboardEvent>): KeyboardEvent {
  return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: '', code: '', ...init } as KeyboardEvent
}

describe('matchesKeybinding', () => {
  it('« Mod » correspond à Ctrl hors macOS et à Cmd sur macOS', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, key: 'p', code: 'KeyP' }), 'Mod+P', false)).toBe(true)
    expect(matchesKeybinding(key({ metaKey: true, key: 'p', code: 'KeyP' }), 'Mod+P', true)).toBe(true)
    expect(matchesKeybinding(key({ ctrlKey: true, key: 'p', code: 'KeyP' }), 'Mod+P', true)).toBe(false)
  })

  it('exige exactement les modificateurs demandés', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, shiftKey: true, key: 'P', code: 'KeyP' }), 'Mod+P', false)).toBe(false)
    expect(matchesKeybinding(key({ ctrlKey: true, shiftKey: true, key: 'P', code: 'KeyP' }), 'Mod+Shift+P', false)).toBe(true)
  })

  it('se base sur la touche physique (claviers AZERTY)', () => {
    // Sur AZERTY, la touche physique « KeyQ » produit « a ».
    expect(matchesKeybinding(key({ ctrlKey: true, key: 'a', code: 'KeyQ' }), 'Mod+A', false)).toBe(true)
    expect(matchesKeybinding(key({ ctrlKey: true, key: '²', code: 'Backquote' }), 'Ctrl+[Backquote]', false)).toBe(true)
  })

  it('gère la ponctuation et les touches nommées', () => {
    expect(matchesKeybinding(key({ ctrlKey: true, key: ',', code: 'Comma' }), 'Mod+,', false)).toBe(true)
    expect(matchesKeybinding(key({ key: 'F1', code: 'F1' }), 'F1', false)).toBe(true)
  })
})

describe('formatKeybinding', () => {
  it('affiche les noms français', () => {
    expect(formatKeybinding('Mod+Shift+P', false)).toBe('Ctrl+Maj+P')
    expect(formatKeybinding('Ctrl+[Backquote]', false)).toBe('Ctrl+`')
    expect(formatKeybinding('Mod+Shift+P', true)).toBe('⌘⇧P')
  })
})
