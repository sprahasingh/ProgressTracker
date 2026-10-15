import type { GoalPlanningConfiguration, TrackerMetricDefinition } from '../../domain/trackers/types'
import { activeTrackerMetrics } from '../../domain/trackers/types'
import { InfoButton } from '../../components/ui/InfoButton'
import { SectionHeader } from '../../components/ui/SectionHeader'
import { calendarDateLabel } from '../shared/localDates'

type Props = {
  metrics: TrackerMetricDefinition[]
  planning: GoalPlanningConfiguration
  deadline?: string
  onChange: (planning: GoalPlanningConfiguration) => void
}

export function GoalPlanningEditor({ metrics, planning, deadline, onChange }: Props) {
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

  return <section data-validation-path="goalPlanning" className="configuration-section goal-planning-editor" aria-labelledby="goal-planning-heading">
    <SectionHeader title="Your plan" headingId="goal-planning-heading" description="Set what you want to achieve and when." help={{ title: 'Planning targets', summary: 'Planning targets are separate from check-in success thresholds.', description: 'Daily plans assess each scheduled date independently. Deadline plans sum incremental entries; snapshot entries already represent totals and are never added together. Switching modes preserves both target maps and saved check-ins.' }} />
    <label className="form-field goal-planning-mode"><span>How should progress work? <InfoButton title="Planning mode" summary="Choose whether the target repeats or builds toward one total." description="Daily plans repeat a target on each scheduled day. Deadline plans set one total to reach by a date. Only incremental metrics can use a cumulative deadline target." /></span><select data-validation-path="goalPlanning.mode" aria-label="Planning mode" className="auth-input" value={planning.mode} onChange={(event) => onChange({ ...planning, mode: event.target.value as GoalPlanningConfiguration['mode'] })}>
      <option value="daily-recurring">Repeat a target each scheduled day</option>
      <option value="cumulative-deadline">Reach a total by the deadline</option>
    </select></label>
    {planning.mode === 'cumulative-deadline' && <p className={`goal-planning-note${deadline ? '' : ' is-warning'}`} role={deadline ? undefined : 'status'}>{deadline ? <>Deadline: <strong>{calendarDateLabel(deadline)}</strong>. Pace is based on your remaining scheduled days.</> : 'Add a deadline to use a total target.'}</p>}
    <div className="goal-planning-metrics">
      {metrics.length === 0 && <p className="configuration-empty">Add a measure before configuring planning targets.</p>}
      {activeTrackerMetrics(metrics).map((metric) => {
        if (metric.valueType === 'boolean') return <article className="goal-planning-metric" key={metric.id}><strong>{metric.name}</strong><p>Yes/no measures do not support numeric planning targets.</p></article>
        const semantics = planning.progressSemantics[metric.id] ?? 'snapshot'
        const hasCumulativeTarget = planning.cumulativeTargets[metric.id] !== undefined
        const step = metric.valueType === 'checklist' ? '1' : 'any'
        const max = metric.valueType === 'checklist' ? metric.checklistItems?.length : undefined
        const unit = metric.valueType === 'checklist' ? 'completed items' : metric.unit || 'units'
        return <article className="goal-planning-metric" key={metric.id}>
          <div className="goal-planning-metric-heading"><strong>{metric.name}</strong><span>{unit}</span></div>
          <label className="form-field"><span>How each entry counts <InfoButton title="Entry meaning" summary="Choose whether a saved value adds new work or reports a running total." description="Incremental values are summed. Snapshot values already represent a total and are never added together. Changing to incremental affects how retained recorded history is interpreted, so the editor asks for confirmation first." /></span><select aria-label="Entry meaning for cumulative plans" className="auth-input" value={semantics} onChange={(event) => updateSemantics(metric, event.target.value as 'incremental' | 'snapshot')}>
            <option value="snapshot" disabled={hasCumulativeTarget}>Snapshot · this value is already a total</option>
            <option value="incremental">Incremental · this entry adds new progress</option>
          </select></label>
          {metric.valueType === 'checklist' && <p className="field-hint">Counts checked items per entry. Daily maximum: {max ?? 0}.</p>}
          <div className={`goal-planning-targets ${planning.mode}`}>
          <label className="form-field"><span>Target per scheduled day <InfoButton title="Daily target" summary="Set the amount expected on each scheduled day." description="Only scheduled days count; rest days are neutral. Checklist targets count checked items and cannot exceed the checklist size. Example: aim for 5 pages on every scheduled study day. This is not a per-check-in achievement threshold." /></span><input data-validation-path={`goalPlanning.dailyTargets.${metric.id}`} aria-label={`${metric.name} daily planning target`} className="auth-input" type="number" min="0.01" max={max} step={step === '1' ? 1 : metric.precision?.increment ?? 'any'} value={planning.dailyTargets[metric.id] ?? ''} onChange={(event) => updateTarget('dailyTargets', metric.id, event.target.value)} /></label>
            <label className="form-field"><span>Total by deadline <InfoButton title="Cumulative target" summary="Set the total amount of incremental work to complete by the deadline." description="The planner compares summed eligible incremental entries with this total, then shows expected progress, remaining work, and required pace. Example: reach 100 problems by October 31. Snapshot metrics cannot use this target because snapshots must not be summed." /></span><input data-validation-path={`goalPlanning.cumulativeTargets.${metric.id}`} aria-label={`${metric.name} cumulative planning target`} className="auth-input" type="number" min="0.01" step={step === '1' ? 1 : metric.precision?.increment ?? 'any'} disabled={semantics !== 'incremental'} value={planning.cumulativeTargets[metric.id] ?? ''} onChange={(event) => updateTarget('cumulativeTargets', metric.id, event.target.value)} />{semantics !== 'incremental' && <small className="field-hint">Choose incremental entry meaning to configure a cumulative target.</small>}</label>
          </div>
        </article>
      })}
    </div>
  </section>
}
