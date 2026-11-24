import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export type SidebarItem = { key: string; selectable: boolean; parent?: string }
const ROW_HEIGHT = 32
const OVERSCAN = 6

/** Fixed-height navigation rows: a 5000-thread archive still mounts about one screenful. */
export function VirtualSidebar<T extends SidebarItem>({ items, activeKey, label, render }: {
  items: T[]; activeKey: string | null; label: string; render: (item: T) => ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 480 })
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const focusAfterRender = useRef<string | null>(null)
  const lastActive = useRef<string | null | undefined>(undefined)
  const maxTop = Math.max(0, items.length * ROW_HEIGHT - viewport.height)
  const start = Math.max(0, Math.floor(Math.min(viewport.top, maxTop) / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(items.length, Math.ceil((Math.min(viewport.top, maxTop) + viewport.height) / ROW_HEIGHT) + OVERSCAN)
  const indexes = Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i)
  const focused = focusedKey ? items.findIndex((i) => i.key === focusedKey) : -1
  if (focused >= 0 && (focused < start || focused >= end)) indexes.push(focused)

  function reveal(index: number) {
    const el = ref.current
    if (!el) return
    const height = el.clientHeight || viewport.height
    const top = index * ROW_HEIGHT
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_HEIGHT > el.scrollTop + height) el.scrollTop = top + ROW_HEIGHT - height
    setViewport({ top: el.scrollTop, height })
  }
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setViewport({ top: el.scrollTop, height: el.clientHeight || 480 })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (lastActive.current === activeKey) return
    lastActive.current = activeKey
    const index = activeKey ? items.findIndex((i) => i.key === activeKey) : -1
    if (index >= 0) reveal(index)
  }, [activeKey, items])
  useLayoutEffect(() => {
    const key = focusAfterRender.current
    if (!key) return
    const index = items.findIndex((item) => item.key === key)
    const row = ref.current?.querySelector<HTMLElement>(`[data-sidebar-index="${index}"]`)
    const target = row?.querySelector<HTMLElement>('[data-thread-row], [data-project-row]')
    if (target) { focusAfterRender.current = null; target.focus({ preventScroll: true }) }
  })
  return <div ref={ref} data-virtual-sidebar={label} className="min-h-0 flex-1 overflow-y-auto px-1" aria-label={label}
    onScroll={(event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight || 480 })}
    onFocusCapture={(event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-sidebar-index]')
      const item = row ? items[Number(row.dataset.sidebarIndex)] : undefined
      if (item) setFocusedKey(item.key)
    }}
    onKeyDown={(event) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing) return
      const target = event.target as HTMLElement
      if (!target.matches('[data-thread-row], [data-project-row]')) return
      const row = target.closest<HTMLElement>('[data-sidebar-index]')
      const current = row ? Number(row.dataset.sidebarIndex) : -1
      let next = current
      if (event.key === 'ArrowLeft' && items[current]?.parent) next = items.findIndex((i) => i.key === items[current]?.parent)
      else if (event.key === 'ArrowRight' && target.matches('[data-project-row]')) next = items.findIndex((i) => i.parent === items[current]?.key)
      else if (event.key === 'Home') { next = 0; while (next < items.length && !items[next]?.selectable) next++ }
      else if (event.key === 'End') { next = items.length - 1; while (next >= 0 && !items[next]?.selectable) next-- }
      else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const direction = event.key === 'ArrowDown' ? 1 : -1
        next += direction
        while (next >= 0 && next < items.length && !items[next]?.selectable) next += direction
      } else return
      const item = items[next]
      if (!item || !item.selectable) return
      event.preventDefault()
      focusAfterRender.current = item.key
      setFocusedKey(item.key)
      reveal(next)
    }}>
    <ul className="relative m-0 list-none p-0" style={{ height: items.length * ROW_HEIGHT }}>
      {indexes.map((index) => {
        const item = items[index]!
        return <li key={item.key} data-sidebar-index={index} aria-posinset={index + 1} aria-setsize={items.length} className="absolute left-0 right-0" style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}>{render(item)}</li>
      })}
    </ul>
  </div>
}
