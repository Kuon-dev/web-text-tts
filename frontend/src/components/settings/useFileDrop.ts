import { useState, type DragEvent } from "react"

/** Drag-and-drop file handling for any element: spread `dropProps` on it. */
export function useFileDrop(onFile: (f: File) => void) {
  const [dragging, setDragging] = useState(false)
  const dropProps = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      e.preventDefault()
      setDragging(true)
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
      setDragging(false)
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault()
      setDragging(false)
      const f = e.dataTransfer.files[0]
      if (f) onFile(f)
    },
  }
  return { dragging, dropProps }
}
