import type { ReactNode, SVGProps } from 'react'

export type AppIconName = 'today' | 'trackers' | 'calendar' | 'insights' | 'holiday' | 'settings' | 'bin' | 'more' | 'spark' | 'account' | 'habit' | 'goal' | 'challenge' | 'project' | 'home' | 'mail' | 'loading' | 'close' | 'add' | 'check' | 'info' | 'lock' | 'chevron-down' | 'status-pending' | 'status-upcoming' | 'status-completed' | 'status-partial' | 'status-no-progress' | 'status-historical' | 'status-outside-period' | 'status-missed' | 'status-skipped' | 'status-holiday' | 'status-unscheduled' | 'status-inactive' | 'status-no-trackers'

const paths: Record<AppIconName, ReactNode> = {
  today: <><rect x="3.5" y="5" width="17" height="16" rx="2.5" /><path d="M7.5 3v4M16.5 3v4M3.5 9.5h17M8 14l2.2 2.2L16 11" /></>,
  trackers: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="16" rx="2.5" /><path d="M7.5 3v4M16.5 3v4M3.5 9.5h17M8 13h2M14 13h2M8 17h2M14 17h2" /></>,
  insights: <><path d="M4 19.5h16M6.5 16V11M11.5 16V5M16.5 16V8" /><path d="m5.5 8 5-3 5 3 4-3" /></>,
  holiday: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.7 4.7l1.4 1.4m11.8 11.8 1.4 1.4M2.5 12h2m15 0h2M4.7 19.3l1.4-1.4M17.9 6.1l1.4-1.4" /></>,
  settings: <><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="m19.4 13.5 1.1.9-1.5 2.6-1.4-.5a7.8 7.8 0 0 1-1.5.9l-.3 1.5h-3l-.3-1.5a7.8 7.8 0 0 1-1.5-.9l-1.4.5-1.5-2.6 1.1-.9a7 7 0 0 1 0-1.8l-1.1-.9 1.5-2.6 1.4.5a7.8 7.8 0 0 1 1.5-.9l.3-1.5h3l.3 1.5a7.8 7.8 0 0 1 1.5.9l1.4-.5 1.5 2.6-1.1.9a7 7 0 0 1 0 1.8Z" transform="translate(-1 -1)" /></>,
  bin: <><path d="M4 7h16M9 7V4.5h6V7m-8 0 1 13h8l1-13M10 11v5m4-5v5" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  account: <><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></>,
  habit: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.6 9a7 7 0 0 1 11.8-2L20 12M4 12l2.6 5a7 7 0 0 0 11.8-2" /></>,
  goal: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><path d="m12 12 5-5" /></>,
  challenge: <><path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z" /></>,
  project: <><path d="M3.5 7.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11Z" /><path d="M3.5 9.5V6a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2" /></>,
  home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-6v-7h-4v7H4a1 1 0 0 1-1-1V10Z" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  loading: <><path d="M20 12a8 8 0 0 1-13.7 5.7M4 12A8 8 0 0 1 17.7 6.3" /><path d="M4 17v-5h5M20 7v5h-5" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  add: <><path d="M12 5v14M5 12h14" /></>,
  check: <><path d="m5 12.5 4.5 4L19 7" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  lock: <><rect x="4.5" y="10" width="15" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  'chevron-down': <><path d="m6 9 6 6 6-6" /></>,
  'status-pending': <><circle cx="12" cy="12" r="7.5" /></>,
  'status-upcoming': <><rect x="4" y="5.5" width="16" height="15" rx="2" /><path d="M8 3.5v4M16 3.5v4M4 10h16M12 13v3l2 1" /></>,
  'status-completed': <><path d="m5 12.5 4.5 4L19 7" /></>,
  'status-partial': <><path d="M12 4.5a7.5 7.5 0 1 0 0 15V4.5Z" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="7.5" /></>,
  'status-no-progress': <><circle cx="12" cy="12" r="7.5" /><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" /></>,
  'status-historical': <><circle cx="12" cy="12" r="7.5" /><path d="M12 7.5V12l3 2" /></>,
  'status-missed': <><path d="M12 4v9M12 17.5v.5" /></>,
  'status-skipped': <><circle cx="12" cy="12" r="7.5" /><path d="m9 9 6 6m0-6-6 6" /></>,
  'status-holiday': <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.7 4.7l1.4 1.4m11.8 11.8 1.4 1.4M2.5 12h2m15 0h2M4.7 19.3l1.4-1.4M17.9 6.1l1.4-1.4" /></>,
  'status-unscheduled': <><path d="M6 12h12" /></>,
  'status-outside-period': <><path d="M5 4v16M19 4v16M9 8h6M9 12h6M9 16h6" /></>,
  'status-inactive': <><circle cx="12" cy="12" r="7.5" /><path d="M12 8v4l2.5 1.5" /></>,
  'status-no-trackers': <><circle cx="9" cy="9" r="4" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 8h5M18.5 5.5v5" /></>,
  spark: <><path d="m12 3 1.8 6.2L20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8L12 3Z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" /></>,
}

export function AppIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: AppIconName }) {
  return <svg data-icon={name} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{paths[name]}</svg>
}
