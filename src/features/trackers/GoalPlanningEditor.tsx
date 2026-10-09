import type { GoalPlanningConfiguration, TrackerMetricDefinition } from '../../domain/trackers/types'
import { InfoButton } from '../../components/ui/InfoButton'

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
    <header className="configuration-heading"><div><h2 id="goal-planning-heading">Planning targets</h2><p>Planning targets are separate from the per-check-in minimum, target, and stretch thresholds above.</p></div><InfoButton title="Planning targets" summary="Plan progress separately from the success threshold of each check-in." description="Each metric has its own unit and target. Daily recurring plans assess each scheduled date independently. Cumulative deadline plans add only incremental entries; snapshots already represent totals and are never summed. Switching modes preserves both target maps and historical check-ins." /></header>
    <label className="form-field goal-planning-mode"><span>Planning mode <InfoButton title="Planning mode" summary="Choose whether the target repeats or accumulates by a deadline." description="Daily recurring repeats a target on each scheduled day, such as 5 pages every weekday. Cumulative deadline sets one total by a date, such as 100 pages by October 31. Only incremental metrics add together in cumulative mode." /></span><select aria-label="Planning mode" className="auth-input" value={planning.mode} onChange={(event) => onChange({ ...planning, mode: event.target.value as GoalPlanningConfiguration['mode'] })}>
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
          <label className="form-field"><span>Entry meaning for cumulative plans <InfoButton title="Entry meaning" summary="Tell cumulative plans whether each saved value adds new work or reports a running total." description="Incremental means each entry adds work completed on that date, so eligible values are summed. Snapshot means the entry is already a total-to-date and must not be added to other snapshots. Changing to incremental explicitly affects how retained recorded history is interpreted; the editor asks for confirmation first." /></span><select aria-label="Entry meaning for cumulative plans" className="auth-input" value={semantics} onChange={(event) => updateSemantics(metric, event.target.value as 'incremental' | 'snapshot')}>
            <option value="snapshot" disabled={hasCumulativeTarget}>Snapshot · this value is already a total</option>
            <option value="incremental">Incremental · this entry adds new progress</option>
          </select></label>
          {metric.valueType === 'checklist' && <p className="field-hint">Each entry contributes the number of checked items. A daily target cannot exceed {max ?? 0}; a cumulative total may span repeated scheduled days.</p>}
          <div className="goal-planning-targets">
          <label className="form-field"><span>Target per scheduled day <InfoButton title="Daily target" summary="Set the amount expected on each scheduled day." description="Only scheduled days count; rest days are neutral. Checklist targets count checked items and cannot exceed the checklist size. Example: aim for 5 pages on every scheduled study day. This is not a per-check-in achievement threshold." /></span><input aria-label={`${metric.name} daily planning target`} className="auth-input" type="number" min="0" max={max} step={step === '1' ? 1 : metric.precision?.increment ?? 'any'} value={planning.dailyTargets[metric.id] ?? ''} onChange={(event) => updateTarget('dailyTargets', metric.id, event.target.value)} /></label>
            <label className="form-field"><span>Total by deadline <InfoButton title="Cumulative target" summary="Set the total amount of incremental work to complete by the deadline." description="The planner compares summed eligible incremental entries with this total, then shows expected progress, remaining work, and required pace. Example: reach 100 problems by October 31. Snapshot metrics cannot use this target because snapshots must not be summed." /></span><input aria-label={`${metric.name} cumulative planning target`} className="auth-input" type="number" min="0" step={step === '1' ? 1 : metric.precision?.increment ?? 'any'} disabled={semantics !== 'incremental'} value={planning.cumulativeTargets[metric.id] ?? ''} onChange={(event) => updateTarget('cumulativeTargets', metric.id, event.target.value)} />{semantics !== 'incremental' && <small className="field-hint">Choose incremental entry meaning to configure a cumulative target.</small>}</label>
          </div>
        </article>
      })}
    </div>
  </section>
}
