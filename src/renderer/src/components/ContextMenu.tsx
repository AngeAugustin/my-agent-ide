import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { formatKeybinding } from '../lib/keybindings'

export interface MenuItem {
  label?: string
  keybinding?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  run?: () => void
}

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[] } | null
}

const useMenu = create<MenuState>()(() => ({ menu: null }))

export function showContextMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: MenuItem[]): void {
  e.preventDefault()
  e.stopPropagation()
  useMenu.setState({ menu: { x: e.clientX, y: e.clientY, items } })
}

function hide() {
  useMenu.setState({ menu: null })
}

export function ContextMenu() {
  const menu = useMenu((s) => s.menu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const { width, height } = ref.current.getBoundingClientRect()
    setPos({
      x: Math.min(menu.x, window.innerWidth - width - 4),
      y: Math.min(menu.y, window.innerHeight - height - 4)
    })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide()
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', hide)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', hide)
    }
  }, [menu])

  if (!menu) return null
  return (
    <div className="context-menu-backdrop" onMouseDown={hide} onContextMenu={(e) => { e.preventDefault(); hide() }}>
      <div
        ref={ref}
        className="context-menu"
        style={{ left: pos.x, top: pos.y }}
        role="menu"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {menu.items.map((item, i) =>
          item.separator ? (
            <div key={i} className="context-menu-separator" />
          ) : (
            <button
              key={i}
              role="menuitem"
              className={`context-menu-item${item.danger ? ' danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                hide()
                item.run?.()
              }}
            >
              <span>{item.label}</span>
              {item.keybinding && <span className="keybinding">{formatKeybinding(item.keybinding)}</span>}
            </button>
          )
        )}
      </div>
    </div>
  )
}
