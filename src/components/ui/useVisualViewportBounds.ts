import { useEffect } from 'react'

/** Keeps fixed modal layers inside the visible viewport, including when a
 * mobile virtual keyboard shrinks or pans that viewport. */
export function useVisualViewportBounds(open: boolean, elementRef: { current: HTMLElement | null }) {
  useEffect(() => {
    const element = elementRef.current
    if (!open || !element) return
    const viewport = window.visualViewport
    const update = () => {
      const current = window.visualViewport
      const top = current?.offsetTop ?? 0
      const left = current?.offsetLeft ?? 0
      const height = current?.height ?? window.innerHeight
      const width = current?.width ?? window.innerWidth
      element.style.top = `${top}px`
      element.style.left = `${left}px`
      element.style.width = `${width}px`
      element.style.height = `${height}px`
      element.style.setProperty('--modal-visible-height', `${height}px`)
    }
    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      element.style.removeProperty('top')
      element.style.removeProperty('left')
      element.style.removeProperty('width')
      element.style.removeProperty('height')
      element.style.removeProperty('--modal-visible-height')
    }
  }, [open, elementRef])
}
