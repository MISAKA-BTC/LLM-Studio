import { Activity, useState, type ReactNode } from 'react'

/**
 * A workbench slot: pay for its first render only when it is opened, then keep its DOM and
 * local state for the next visit. Activity disconnects effects while hidden, so a retained
 * pane does not keep polling, observing layout, or listening for keys in the background.
 *
 * Long-running jobs belong in window-level services/stores, outside this boundary. Effects in
 * a pane must be safe to resume without resetting its draft, selection, or scroll position.
 * No wrapper element is added, so existing flex/grid sizing continues to work.
 */
export function RetainedView({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active)
  // A conditional update of this component's own state is deliberate: the first visible render
  // is retained even if another navigation arrives before passive effects have run.
  if (active && !visited) setVisited(true)
  if (!active && !visited) return null

  return <Activity mode={active ? 'visible' : 'hidden'}>{children}</Activity>
}
