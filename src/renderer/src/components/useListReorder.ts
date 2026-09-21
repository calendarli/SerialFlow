import { useRef, useState } from 'react'
import type { DragEvent, HTMLAttributes } from 'react'

// Reorder only on drop so cancelled drags never change the saved configuration.
export function useListReorder<T extends { id: number }>(
  items: T[],
  onReorder: (items: T[], source: T, target: T) => void,
  canReorder: (source: T, target: T) => boolean = () => true,
  notifyUnchanged = false
): {
  start: (event: DragEvent, item: T) => void
  clear: () => void
  dropProps: (item: T) => HTMLAttributes<HTMLElement>
  className: (item: T) => string
} {
  const sourceId = useRef<number | null>(null)
  const [draggedId, setDraggedId] = useState<number | null>(null)
  const [target, setTarget] = useState<{ id: number; after: boolean } | null>(null)
  const clear = (): void => {
    sourceId.current = null
    setDraggedId(null)
    setTarget(null)
  }
  const locate = (event: DragEvent<HTMLElement>): boolean => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY >= rect.top + rect.height / 2
  }
  return {
    start: (event, item) => {
      event.stopPropagation()
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('application/x-serialflow-list-item', String(item.id))
      sourceId.current = item.id
      setDraggedId(item.id)
      setTarget(null)
    },
    clear,
    className: (item) =>
      `${draggedId === item.id ? 'list-is-dragging' : ''} ${target?.id === item.id ? (target.after ? 'list-drop-after' : 'list-drop-before') : ''}`,
    dropProps: (item) => ({
      onDragOver: (event) => {
        const source = items.find((entry) => entry.id === sourceId.current)
        if (!source || !canReorder(source, item)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = source.id === item.id ? 'none' : 'move'
        setTarget(source.id === item.id ? null : { id: item.id, after: locate(event) })
      },
      onDragLeave: (event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setTarget((current) => (current?.id === item.id ? null : current))
      },
      onDrop: (event) => {
        const source = items.find((entry) => entry.id === sourceId.current)
        if (!source || !canReorder(source, item)) return
        event.preventDefault()
        event.stopPropagation()
        if (source.id !== item.id) {
          const next = items.filter((entry) => entry.id !== source.id)
          const index = next.findIndex((entry) => entry.id === item.id)
          next.splice(index + (locate(event) ? 1 : 0), 0, source)
          if (next.some((entry, i) => entry.id !== items[i].id) || notifyUnchanged)
            onReorder(next, source, item)
        }
        clear()
      }
    })
  }
}
