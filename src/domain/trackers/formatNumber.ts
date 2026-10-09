/** Compact display for numeric progress; stored and calculated values are untouched. */
export function formatTrackerNumber(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)
}
