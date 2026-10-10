import { useEffect, useRef } from 'react'

type Layer = {
  element: HTMLElement
  onEscape: () => void
  token: string
  coveredLayer?: Layer
  previousInert?: boolean
  previousAriaHidden?: string | null
}

const layers: Layer[] = []
let originalBodyOverflow = ''
let layerSequence = 0
const historyKey = '__progressTrackerModalLayer'

function lockBody() {
  if (layers.length === 0) {
    originalBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
}

/** Coordinates focus trapping and body scroll locking for nested modal layers. */
export function useModalLayer(open: boolean, elementRef: { current: HTMLElement | null }, onEscape: () => void) {
  const escapeRef = useRef(onEscape)
  const tokenRef = useRef<string | null>(null)
  if (tokenRef.current === null) tokenRef.current = `modal-${++layerSequence}`
  escapeRef.current = onEscape

  useEffect(() => {
    const element = elementRef.current
    if (!open || !element) return

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const token = tokenRef.current!
    if ((window.history.state as Record<string, unknown> | null)?.[historyKey] !== token) {
      const previousState = window.history.state
      const state = previousState && typeof previousState === 'object' ? previousState as Record<string, unknown> : {}
      window.history.pushState({ ...state, [historyKey]: token }, '')
    }
    lockBody()
    const coveredLayer = layers.at(-1)
    const layer: Layer = {
      element,
      onEscape: () => escapeRef.current(),
      token,
      ...(coveredLayer ? {
        coveredLayer,
        previousInert: coveredLayer.element.inert,
        previousAriaHidden: coveredLayer.element.getAttribute('aria-hidden'),
      } : {}),
    }
    if (coveredLayer) {
      coveredLayer.element.inert = true
      coveredLayer.element.setAttribute('aria-hidden', 'true')
    }
    layers.push(layer)

    const onKeyDown = (event: KeyboardEvent) => {
      if (layers.at(-1) !== layer) return
      if (event.key === 'Escape') {
        event.preventDefault()
        layer.onEscape()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [
        ...element.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
        ...document.querySelectorAll<HTMLElement>('.toast-stack button:not([disabled])'),
      ]
      if (!focusable.length) {
        event.preventDefault()
        element.focus()
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    const onPopState = (event: PopStateEvent) => {
      if (layers.at(-1) !== layer || (event.state as Record<string, unknown> | null)?.[historyKey] === token) return
      layer.onEscape()
      window.setTimeout(() => {
        // A discard confirmation may cancel closing. Restore the modal history
        // entry so the next Android/browser back press still belongs to it.
        if (layers.at(-1) === layer && (window.history.state as Record<string, unknown> | null)?.[historyKey] !== token) {
          const previousState = window.history.state
          const state = previousState && typeof previousState === 'object' ? previousState as Record<string, unknown> : {}
          window.history.pushState({ ...state, [historyKey]: token }, '')
        }
      }, 0)
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('popstate', onPopState)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('popstate', onPopState)
      const index = layers.indexOf(layer)
      if (index >= 0) layers.splice(index, 1)
      if (layer.coveredLayer && layers.includes(layer.coveredLayer)) {
        layer.coveredLayer.element.inert = layer.previousInert ?? false
        if (layer.previousAriaHidden === null || layer.previousAriaHidden === undefined) layer.coveredLayer.element.removeAttribute('aria-hidden')
        else layer.coveredLayer.element.setAttribute('aria-hidden', layer.previousAriaHidden)
      }
      if (layers.length === 0) document.body.style.overflow = originalBodyOverflow
      queueMicrotask(() => {
        if (layers.some((activeLayer) => activeLayer.token === token)) return
        if ((window.history.state as Record<string, unknown> | null)?.[historyKey] === token) window.history.back()
      })
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [open, elementRef])
}
