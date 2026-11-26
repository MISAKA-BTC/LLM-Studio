import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { ReadableFile } from './attachments'
import { useStudio } from '../store/studio'

type DropTarget =
  | { kind: 'text'; onFiles: (files: ReadableFile[]) => void; onFolderPaths?: (paths: string[]) => void }
  | { kind: 'image'; onFiles: (files: File[]) => void }
  | { kind: 'folder'; onPaths: (paths: (string | null)[]) => void }

type NativeFile = { name: string } & ({ error: string } | { size: number; mime: string; base64: string })
type DesktopDrop =
  | { type: 'hover'; point: [number, number] }
  | { type: 'leave' }
  | { type: 'drop'; point: [number, number]; id: number; paths: (string | null)[]; read?: 'text' | 'image' }
  | { type: 'files'; id: number; files: NativeFile[] }

export const hasNativeFileDrop = (globalThis as { __MISAKA_STUDIO_NATIVE_DROP__?: boolean }).__MISAKA_STUDIO_NATIVE_DROP__ === true

export function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer.types.includes('Files')
}

function deliverNativeFiles(
  target: Exclude<DropTarget, { kind: 'folder' }>,
  files: NativeFile[],
  paths: (string | null)[],
) {
  const folderPaths: string[] = []
  const valid = files.flatMap((file, index) => {
    if ('error' in file) {
      const rawPath = paths[index]
      if (target.kind === 'text' && target.onFolderPaths && rawPath && file.error === 'Select a file to attach.') {
        folderPaths.push(rawPath)
        return []
      }
      useStudio.getState().toast('info', `${file.name}: ${file.error}`)
      return []
    }
    return [{ ...file, bytes: Uint8Array.from(atob(file.base64), (byte) => byte.charCodeAt(0)) }]
  })

  if (target.kind === 'text' && target.onFolderPaths && folderPaths.length > 0) {
    target.onFolderPaths(folderPaths)
  }

  if (valid.length === 0) return

  if (target.kind === 'image') {
    target.onFiles(valid.map(({ name, mime, bytes }) => new File([bytes], name, { type: mime })))
  } else {
    target.onFiles(
      valid.map(({ name, size, bytes }) => {
        const blob = new Blob([bytes])
        return { name, size, slice: (start, end) => blob.slice(start, end) }
      }),
    )
  }
}

export function useFileDrop(target: DropTarget) {
  const dropRef = useRef<HTMLDivElement>(null)
  const latest = useRef(target)
  latest.current = target
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const pending = new Map<number, { receiver: Exclude<DropTarget, { kind: 'folder' }>; paths: (string | null)[] }>()
    const onDesktopDrop = (event: Event) => {
      const detail = (event as CustomEvent<DesktopDrop>).detail
      if (detail.type === 'files') {
        const entry = pending.get(detail.id)
        pending.delete(detail.id)
        if (entry) deliverNativeFiles(entry.receiver, detail.files, entry.paths)
        return
      }
      const hit = detail.type === 'leave' ? null : document.elementFromPoint(...detail.point)
      const inside = hit !== null && dropRef.current?.contains(hit)
      setDragging(detail.type === 'hover' && !!inside)
      if (detail.type !== 'drop' || !inside) return
      const receiver = latest.current
      if (receiver.kind === 'folder') {
        receiver.onPaths(detail.paths)
      } else {
        pending.set(detail.id, { receiver, paths: detail.paths })
        detail.read = receiver.kind
      }
    }
    if (hasNativeFileDrop) window.addEventListener('misaka-desktop-drop', onDesktopDrop)
    return () => window.removeEventListener('misaka-desktop-drop', onDesktopDrop)
  }, [])

  const dropHandlers = {
    onDragEnter: (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    },
    onDragOver: (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    },
    onDrop: (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const files = Array.from(event.dataTransfer.files)
      if (target.kind === 'folder') target.onPaths([])
      else if (files.length) target.onFiles(files)
    },
  }

  return { dragging, dropHandlers, dropRef }
}
