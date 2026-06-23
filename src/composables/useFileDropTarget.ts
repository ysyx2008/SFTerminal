import { ref } from 'vue'

function isFileDragEvent(event: DragEvent): boolean {
  return !!event.dataTransfer?.types.includes('Files')
}

export function useFileDropTarget(onDropFiles: (files: FileList) => void | Promise<void>) {
  const isDragOver = ref(false)
  let dragEndListener: (() => void) | null = null

  const clearDragEndListener = () => {
    if (!dragEndListener) return
    document.removeEventListener('dragend', dragEndListener)
    dragEndListener = null
  }

  const resetDragOver = () => {
    isDragOver.value = false
    clearDragEndListener()
  }

  const ensureDragEndListener = () => {
    if (dragEndListener) return
    dragEndListener = () => resetDragOver()
    document.addEventListener('dragend', dragEndListener)
  }

  const handleDragEnter = (event: DragEvent) => {
    if (!isFileDragEvent(event)) return
    event.preventDefault()
    event.stopPropagation()
    isDragOver.value = true
    ensureDragEndListener()
  }

  const handleDragOver = (event: DragEvent) => {
    if (!isFileDragEvent(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (event: DragEvent) => {
    if (!isDragOver.value) return
    event.preventDefault()
    event.stopPropagation()
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const { clientX: x, clientY: y } = event
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      resetDragOver()
    }
  }

  const handleDrop = async (event: DragEvent) => {
    if (!isFileDragEvent(event)) return
    event.preventDefault()
    event.stopPropagation()
    resetDragOver()
    const files = event.dataTransfer?.files
    if (files && files.length > 0) {
      await onDropFiles(files)
    }
  }

  return {
    isDragOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  }
}
