import { InfoButton } from '../../components/ui/InfoButton'
import type { HeatmapDay } from '../../domain/trackers/activityHeatmap'
import { calendarDateLabel } from '../shared/localDates'
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'

export function ActivityHeatmap({ days, trackerName }: { days: readonly HeatmapDay[]; trackerName: string | null }) {
  const [selectedDay, setSelectedDay] = useState<HeatmapDay | null>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const viewport = scrollRef.current
    if (viewport) viewport.scrollLeft = viewport.scrollWidth
  }, [days.length])
  useEffect(() => {
    if (!selectedDay) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedDay(null) }
    const onPointerDown = (event: PointerEvent) => { if (event.target instanceof Node && !sectionRef.current?.contains(event.target)) setSelectedDay(null) }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('keydown', onKeyDown); document.removeEventListener('pointerdown', onPointerDown) }
  }, [selectedDay])
  if (!days.length) return null
  const firstWeekday = (new Date(`${days[0]!.date}T00:00:00.000Z`).getUTCDay() + 6) % 7
  const cells: Array<HeatmapDay | null> = [...Array.from({ length: firstWeekday }, () => null), ...days]
  const columns = Math.ceil(cells.length / 7)
  while (cells.length < columns * 7) cells.push(null)
  const seenMonths = new Set<string>()
  const monthLabels = Array.from({ length: columns }, (_, column) => {
    const week = cells.slice(column * 7, column * 7 + 7).filter((day): day is HeatmapDay => day !== null)
    if (!week.length) return ''
    const monthStart = week.find((day) => day.date.slice(-2) === '01')
    const month = monthStart?.date.slice(0, 7) ?? (column === 0 ? week[0]!.date.slice(0, 7) : null)
    if (!month || seenMonths.has(month)) return ''
    seenMonths.add(month)
    return calendarDateLabel(`${month}-01`, { month: 'short' })
  })
  return <section ref={sectionRef} className="activity-heatmap-section" aria-labelledby="activity-heatmap-title">
    <div className="activity-heatmap-heading"><div><h2 id="activity-heatmap-title">Activity Heatmap</h2><p>{trackerName ? `${trackerName} · last 12 weeks` : 'All Trackers · last 12 weeks'}</p></div><InfoButton title="Activity Heatmap" summary="Each day shows qualifying activity divided by that day’s eligible tracker opportunities." description="In All Trackers, each tracker follows its own schedule and Strict Mode policy; the cell percentage is qualified opportunities divided by eligible opportunities. For one tracker, the same rule applies to that tracker’s streak qualification. Holidays and rest days are excluded in Standard Mode and required in Strict Mode. Neutral cells mean no eligible opportunities; gray means 0%; green shades mean 1–25%, 26–50%, 51–75%, 76–99%, and 100%. Each cell can be tapped or focused for its counts and holiday/rest context." /></div>
    <div ref={scrollRef} className="activity-heatmap-scroll" role="region" aria-label="Scrollable 12-week activity heatmap" tabIndex={0}>
      <div className="activity-heatmap" style={{ '--heatmap-columns': columns } as CSSProperties}>
        <div className="heatmap-months" aria-hidden="true">{monthLabels.map((label, index) => <span key={index}>{label}</span>)}</div>
        <div className="heatmap-body">
          <div className="heatmap-weekdays" aria-hidden="true"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
          <div className="heatmap-cells">{cells.map((day, index) => day ? <button key={day.date} type="button" className={`heatmap-cell heatmap-level-${day.level}${day.holiday ? ' heatmap-holiday' : ''}`} title={heatmapLabel(day, trackerName)} aria-label={heatmapLabel(day, trackerName)} aria-pressed={selectedDay?.date === day.date} onClick={() => setSelectedDay(day)} onFocus={() => setSelectedDay(day)} style={{ gridColumn: Math.floor(index / 7) + 1, gridRow: index % 7 + 1 }} /> : <span key={`blank-${index}`} aria-hidden="true" className="heatmap-cell heatmap-cell-empty" style={{ gridColumn: Math.floor(index / 7) + 1, gridRow: index % 7 + 1 }} />)}</div>
        </div>
      </div>
    </div>
    {selectedDay && <div className="heatmap-detail" role="status"><span>{heatmapLabel(selectedDay, trackerName)}</span><button type="button" className="heatmap-detail-close" aria-label="Close activity detail" onClick={() => setSelectedDay(null)}>×</button></div>}
    <div className="heatmap-legend" aria-label="Heatmap activity intensity"><span>Less</span>{[0, 1, 2, 3, 4, 5, 6].map((level) => <i key={level} className={`heatmap-cell heatmap-level-${level}`} aria-hidden="true" />)}<span>More</span><small>Neutral = no eligible opportunities</small></div>
  </section>
}

function heatmapLabel(day: HeatmapDay, trackerName: string | null): string {
  const date = calendarDateLabel(day.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const context = [day.holiday ? 'Holiday' : '', day.restCount ? `${day.restCount} tracker${day.restCount === 1 ? '' : 's'} had a rest day` : ''].filter(Boolean).join('; ') || 'No holiday or rest-day exception'
  const value = day.percent === null ? 'No eligible opportunities' : `${day.qualifiedCount} of ${day.eligibleCount} eligible tracker opportunities qualified (${day.percent}%)`
  return `${date}: ${value}. ${context}.${trackerName ? ` ${trackerName} view.` : ''}`
}
