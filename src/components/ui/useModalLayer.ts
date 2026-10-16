import { useEffect, useRef } from 'react'

type Layer = {
  element: HTMLElement
  onEscape: () => void
  token: string
  backdrop?: HTMLElement
  previousZIndex?: string
  coveredLayer?: Layer
  previousInert?: boolean
  previousAriaHidden?: string | null
}

const layers: Layer[] = []
let originalBodyOverflow = ''
let originalBodyPosition = ''
let originalBodyTop = ''
let originalBodyWidth = ''
let originalRootOverflow = ''
let lockedScrollY = 0
let layerSequence = 0
const historyKey = '__progressTrackerModalLayer'

function syncBackdropOrder() {
  layers.forEach((layer, index) => {
    if (layer.backdrop) layer.backdrop.style.zIndex = String(10_000 + index)
  })
}

/** True while another modal layer is above the supplied element (or is open
 * while a non-modal surface, such as the desktop AI Help panel, is underneath). */
export function hasModalLayerAbove(element: HTMLElement | null): boolean {
  const top = layers.at(-1)
  return Boolean(top && top.element !== element)
}

function lockBody() {
  if (layers.length === 0) {
    originalBodyOverflow = document.body.style.overflow
    originalBodyPosition = document.body.style.position
    originalBodyTop = document.body.style.top
    originalBodyWidth = document.body.style.width
    originalRootOverflow = document.documentElement.style.overflow
    lockedScrollY = window.scrollY
    // overflow:hidden alone does not stop touch scrolling on iOS. Pin the body
    // at its current visual position while a modal layer owns the interaction.
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    document.body.style.position = 'fixed'
    document.body.style.top = `${-lockedScrollY}px`
    document.body.style.width = '100%'
  }
}

function unlockBody() {
  document.body.style.overflow = originalBodyOverflow
  document.body.style.position = originalBodyPosition
  document.body.style.top = originalBodyTop
  document.body.style.width = originalBodyWidth
  document.documentElement.style.overflow = originalRootOverflow
  if (lockedScrollY) window.scrollTo(0, lockedScrollY)
}

/** Coordinates focus trapping and body scroll locking for nested modal layers. */
export function useModalLayer(open: boolean, elementRef: { current: HTMLElement | null }, onEscape: () => void, options: { manageHistoryEntry?: boolean } = {}) {
  const escapeRef = useRef(onEscape)
  const tokenRef = useRef<string | null>(null)
  if (tokenRef.current === null) tokenRef.current = `modal-${++layerSequence}`
  escapeRef.current = onEscape

  useEffect(() => {
    const element = elementRef.current
    if (!open || !element) return

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const token = tokenRef.current!
    const manageHistoryEntry = options.manageHistoryEntry !== false
    if (manageHistoryEntry && (window.history.state as Record<string, unknown> | null)?.[historyKey] !== token) {
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
      ...(element.closest<HTMLElement>('.modal-backdrop') ? {
        backdrop: element.closest<HTMLElement>('.modal-backdrop')!,
        previousZIndex: element.closest<HTMLElement>('.modal-backdrop')!.style.zIndex,
      } : {}),
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
    syncBackdropOrder()

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
    if (manageHistoryEntry) window.addEventListener('popstate', onPopState)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (manageHistoryEntry) window.removeEventListener('popstate', onPopState)
      const index = layers.indexOf(layer)
      if (index >= 0) layers.splice(index, 1)
      if (layer.backdrop) layer.backdrop.style.zIndex = layer.previousZIndex ?? ''
      syncBackdropOrder()
      if (layer.coveredLayer && layers.includes(layer.coveredLayer)) {
        layer.coveredLayer.element.inert = layer.previousInert ?? false
        if (layer.previousAriaHidden === null || layer.previousAriaHidden === undefined) layer.coveredLayer.element.removeAttribute('aria-hidden')
        else layer.coveredLayer.element.setAttribute('aria-hidden', layer.previousAriaHidden)
      }
      if (layers.length === 0) unlockBody()
      if (manageHistoryEntry) queueMicrotask(() => {
        if (layers.some((activeLayer) => activeLayer.token === token)) return
        if ((window.history.state as Record<string, unknown> | null)?.[historyKey] === token) window.history.back()
      })
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [open, elementRef, options.manageHistoryEntry])
}
