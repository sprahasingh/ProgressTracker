import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AppIcon } from './AppIcon'

export type ToastKind = 'success' | 'error' | 'warning' | 'info'
export type ToastInput = {
  kind: ToastKind
  title: string
  description?: string
  /** Zero keeps the toast open until dismissed or its action completes. */
  duration?: number
  dedupeKey?: string
  action?: { label: string; onClick: () => void | Promise<void> }
}
type ToastItem = ToastInput & { id: number }
type ToastApi = { notify: (toast: ToastInput) => void; dismiss: (id: number) => void }

const emptyToastApi: ToastApi = { notify: () => {}, dismiss: () => {} }
const ToastContext = createContext<ToastApi>(emptyToastApi)
const iconPaths: Record<ToastKind, string> = {
  success: 'M20 6 9 17l-5-5', error: 'M18 6 6 18M6 6l12 12',
  warning: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3l-8.5-14.1a2 2 0 0 0-3.4 0Z',
  info: 'M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const itemsRef = useRef<ToastItem[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const nextId = useRef(1)
  const publish = useCallback((next: ToastItem[]) => { itemsRef.current = next; setItems(next) }, [])
  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) clearTimeout(timer)
    timers.current.delete(id)
    publish(itemsRef.current.filter((item) => item.id !== id))
  }, [publish])
  const notify = useCallback((input: ToastInput) => {
    const existing = input.dedupeKey ? itemsRef.current.find((item) => item.dedupeKey === input.dedupeKey) : undefined
    const id = existing?.id ?? nextId.current++
    const oldTimer = timers.current.get(id)
    if (oldTimer) clearTimeout(oldTimer)
    timers.current.delete(id)
    const duration = input.duration ?? (input.kind === 'success' ? 3000 : input.kind === 'info' ? 3500 : input.kind === 'warning' ? 5000 : input.action ? 0 : 7000)
    const item = { ...input, id, duration }
    const next = existing ? itemsRef.current.map((current) => current.id === id ? item : current) : [...itemsRef.current, item]
    while (next.length > 4) {
      const removable = next.findIndex((candidate) => candidate.id !== id && candidate.duration !== 0 && !candidate.action)
      if (removable < 0) break
      const [removed] = next.splice(removable, 1)
      const timer = timers.current.get(removed!.id)
      if (timer) clearTimeout(timer)
      timers.current.delete(removed!.id)
    }
    publish(next)
    if (duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), duration))
  }, [dismiss, publish])
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); timers.current.clear() }, [])

  return <ToastContext.Provider value={{ notify, dismiss }}>
    {children}
    {typeof document !== 'undefined' && createPortal(<div className="toast-stack" aria-label="Notifications">
      {items.map((item) => {
        const liveRole = item.kind === 'error' ? 'alert' : 'status'
        return <section className={`app-toast app-toast-${item.kind}`} key={item.id} role={liveRole} aria-label={item.title} aria-live={item.kind === 'error' ? 'assertive' : 'polite'} aria-atomic="true">
          <svg className="app-toast-icon" aria-hidden="true" viewBox="0 0 24 24"><path d={iconPaths[item.kind]} /></svg>
          <div className="app-toast-copy"><strong>{item.title}</strong>{item.description && <span>{item.description}</span>}{item.action && <button className="app-toast-action" onClick={() => { void Promise.resolve(item.action?.onClick()).catch(() => undefined); dismiss(item.id) }}>{item.action.label}</button>}</div>
          <button className="app-toast-dismiss" type="button" aria-label={`Dismiss notification: ${item.title}`} onClick={() => dismiss(item.id)}><AppIcon name="close" /></button>
        </section>
      })}
    </div>, document.body)}
  </ToastContext.Provider>
}

export function useToast(): ToastApi { return useContext(ToastContext) }
