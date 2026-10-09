import type { GoalPlanningConfiguration, TrackerMetricDefinition } from '../../domain/trackers/types'

type Props = {
  metrics: TrackerMetricDefinition[]
  planning: GoalPlanningConfiguration
  onChange: (planning: GoalPlanningConfiguration) => void
}

export function GoalPlanningEditor({ metrics, planning, onChange }: Props) {
  function updateTarget(kind: 'dailyTargets' | 'cumulativeTargets', metricId: string, raw: string) {
    const targets = { ...planning[kind] }
    if (raw === '') delete targets[metricId]
    else targets[metricId] = Number(raw)
    onChange({ ...planning, [kind]: targets })
  }

  function updateSemantics(metric: TrackerMetricDefinition, value: 'incremental' | 'snapshot') {
    if (value === 'incremental' && !window.confirm(
      'This will treat each retained recorded value for this measure, including historical entries, as new incremental progress toward a cumulative total. Editing a date replaces that date\'s value, and tombstoned entries are excluded. Saved entries are unchanged. Continue?',
    )) return
    onChange({ ...planning, progressSemantics: { ...planning.progressSemantics, [metric.id]: value } })
  }

  return <section className="configuration-section goal-planning-editor" aria-labelledby="goal-planning-heading">
    <header className="configuration-heading"><div><h2 id="goal-planning-heading">Planning targets</h2><p>Planning targets are separate from the per-check-in minimum, target, and stretch thresholds above.</p></div></header>
    <label className="form-field goal-planning-mode"><span>Planning mode</span><select className="auth-input" value={planning.mode} onChange={(event) => onChange({ ...planning, mode: event.target.value as GoalPlanningConfiguration['mode'] })}>
      <option value="daily-recurring">Daily recurring · repeat targets on scheduled days</option>
      <option value="cumulative-deadline">Cumulative deadline · add incremental work toward a total</option>
    </select></label>
    <p className="field-hint">Changing modes preserves both target sets and all saved check-ins. Daily plans compare each scheduled day independently. Cumulative plans sum only metrics explicitly marked as incremental; snapshot values are never added together. Each measure keeps its own unit and plan.</p>
    {planning.mode === 'cumulative-deadline' && <p className="goal-planning-note">Cumulative mode needs a deadline. Expected progress is distributed evenly across scheduled dates; required pace uses the remaining scheduled dates, including today when scheduled.</p>}
    <div className="goal-planning-metrics">
      {metrics.length === 0 && <p className="configuration-empty">Add a measure before configuring planning targets.</p>}
      {metrics.map((metric) => {
        if (metric.valueType === 'boolean') return <article className="goal-planning-metric" key={metric.id}><strong>{metric.name}</strong><p>Yes/no measures do not support numeric planning targets.</p></article>
        const semantics = planning.progressSemantics[metric.id] ?? 'snapshot'
        const hasCumulativeTarget = planning.cumulativeTargets[metric.id] !== undefined
        const step = metric.valueType === 'checklist' ? '1' : 'any'
        const max = metric.valueType === 'checklist' ? metric.checklistItems?.length : undefined
        const unit = metric.valueType === 'checklist' ? 'completed items' : metric.unit || 'units'
        return <article className="goal-planning-metric" key={metric.id}>
          <div className="goal-planning-metric-heading"><strong>{metric.name}</strong><span>{unit}</span></div>
          <label className="form-field"><span>Entry meaning for cumulative plans</span><select className="auth-input" value={semantics} onChange={(event) => updateSemantics(metric, event.target.value as 'incremental' | 'snapshot')}>
            <option value="snapshot" disabled={hasCumulativeTarget}>Snapshot · this value is already a total</option>
            <option value="incremental">Incremental · this entry adds new progress</option>
          </select></label>
          {metric.valueType === 'checklist' && <p className="field-hint">Each entry contributes the number of checked items. A daily target cannot exceed {max ?? 0}; a cumulative total may span repeated scheduled days.</p>}
          <div className="goal-planning-targets">
            <label className="form-field"><span>Target per scheduled day</span><input aria-label={`${metric.name} daily planning target`} className="auth-input" type="number" min="0" max={max} step={step} value={planning.dailyTargets[metric.id] ?? ''} onChange={(event) => updateTarget('dailyTargets', metric.id, event.target.value)} /></label>
            <label className="form-field"><span>Total by deadline</span><input aria-label={`${metric.name} cumulative planning target`} className="auth-input" type="number" min="0" step={step} disabled={semantics !== 'incremental'} value={planning.cumulativeTargets[metric.id] ?? ''} onChange={(event) => updateTarget('cumulativeTargets', metric.id, event.target.value)} />{semantics !== 'incremental' && <small className="field-hint">Choose incremental entry meaning to configure a cumulative target.</small>}</label>
          </div>
        </article>
      })}
    </div>
  </section>
}
