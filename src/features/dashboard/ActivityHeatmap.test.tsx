import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { HeatmapDay } from '../../domain/trackers/activityHeatmap'
import { ActivityHeatmap } from './ActivityHeatmap'

afterEach(cleanup)

describe('ActivityHeatmap', () => {
  it('labels each visible month once at its first week boundary and keeps all 12 weeks', () => {
    const start = Date.parse('2026-06-08T00:00:00.000Z')
    const days: HeatmapDay[] = Array.from({ length: 84 }, (_, index) => ({
      date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      eligibleCount: 1,
      qualifiedCount: 0,
      percent: 0,
      level: 1,
      holiday: false,
      restCount: 0,
    }))

    const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return this.classList.contains('activity-heatmap-scroll') ? 600 : 0 } })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList.contains('activity-heatmap-scroll') ? 300 : 0 } })
    try {
      const { container } = render(<ActivityHeatmap days={days} trackerName={null} rangeSelection="last12Months" year={2026} years={[2026]} onRangeChange={() => {}} onYearChange={() => {}} scrollToStart={false} />)
      const labels = Array.from(container.querySelectorAll('.heatmap-months span'), (span) => span.textContent).filter(Boolean)
      const shortMonth = (date: string) => new Date(`${date}T12:00:00.000Z`).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })

      expect(labels).toEqual([shortMonth('2026-06-01'), shortMonth('2026-07-01'), shortMonth('2026-08-01')])
      expect(container.querySelectorAll('.heatmap-cells button')).toHaveLength(84)
      expect(Array.from(container.querySelectorAll('.heatmap-weekdays span'), (span) => span.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
      expect(container.querySelector('.activity-heatmap-scroll')).toHaveAttribute('aria-label', 'Scrollable last 12 months activity heatmap')
      expect(container.querySelector('.activity-heatmap-scroll')?.scrollLeft).toBe(600)
      cleanup()
    } finally {
      if (originalScrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth')
      if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
    }
  })
})
