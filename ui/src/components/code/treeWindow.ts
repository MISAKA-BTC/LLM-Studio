// Every explorer row has the same height, so large folders need only the visible slice of DOM.
export const TREE_ROW_HEIGHT = 28
export const TREE_OVERSCAN = 8

export function treeWindow(count: number, scrollTop: number, height: number) {
  const visible = Math.max(1, Math.ceil(Math.max(0, height) / TREE_ROW_HEIGHT))
  const first = Math.min(Math.max(0, count - visible), Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT)))
  return {
    start: Math.max(0, first - TREE_OVERSCAN),
    end: Math.min(count, first + visible + TREE_OVERSCAN + 1),
  }
}
