import type { CustomFieldDefinition, TrackerMetricDefinition, TrackerMilestoneDefinition, TrackerRule, ThresholdConfiguration } from '../../domain/trackers/types'
import { Button } from '../../components/ui/Button'
import { InfoButton } from '../../components/ui/InfoButton'

function freshMetric(index: number): TrackerMetricDefinition {
  return { id: crypto.randomUUID(), name: `Measure ${index + 1}`, valueType: 'quantity', unit: '', thresholds: { direction: 'increase', target: 1, streakQualification: 'any-recorded-value' } }
}

function defaultRule(metric: TrackerMetricDefinition): TrackerRule {
  if (metric.thresholds?.target !== undefined) return { kind: 'threshold', metricId: metric.id, level: 'target' }
  if (metric.thresholds?.minimum !== undefined) return { kind: 'threshold', metricId: metric.id, level: 'minimum' }
  return { kind: 'comparison', metricId: metric.id, operator: 'equals', value: metric.valueType === 'boolean' }
}

function ruleUsesMetric(rule: TrackerRule | undefined, metricId: string): boolean {
  if (!rule) return false
  if (rule.kind === 'threshold' || rule.kind === 'comparison') return rule.metricId === metricId
  return rule.operands.some((operand) => ruleUsesMetric(operand, metricId))
}

type RuleNodeProps = { rule: TrackerRule; metrics: TrackerMetricDefinition[]; path: number[]; onChange: (path: number[], rule: TrackerRule) => void; onRemove?: (path: number[]) => void }

function RuleNode({ rule, metrics, path, onChange, onRemove }: RuleNodeProps) {
  const firstMetric = metrics[0]
  const metricId = rule.kind === 'threshold' || rule.kind === 'comparison' ? rule.metricId : firstMetric?.id
  const metric = metrics.find((item) => item.id === metricId) ?? firstMetric

  function selectKind(kind: string) {
    if (kind === 'all' || kind === 'any') {
      if (metric) {
        const fallback = defaultRule(metric)
        onChange(path, { kind, operands: [fallback, defaultRule(metric)] })
      }
    } else if (kind === 'at-least') {
      const fallback = metric ? defaultRule(metric) : null
      if (fallback) onChange(path, { kind, required: 1, operands: [fallback] })
    } else if (metric && kind === 'threshold') {
      const levels = ['minimum', 'target', 'stretch'] as const
      const level = levels.find((name) => metric.thresholds?.[name] !== undefined)
      if (level) onChange(path, { kind, metricId: metric.id, level })
    } else if (metric && kind === 'comparison') {
      onChange(path, { kind, metricId: metric.id, operator: metric.valueType === 'boolean' ? 'equals' : 'at-least', value: metric.valueType === 'boolean' })
    }
  }

  function changeOperand(childPath: number[], updated: TrackerRule) {
    if (rule.kind !== 'all' && rule.kind !== 'any' && rule.kind !== 'at-least') return
    const index = childPath.at(-1)
    if (index === undefined) return
    onChange(path, { ...rule, operands: rule.operands.map((operand, i) => i === index ? updated : operand) })
  }

  return (
    <div className={`rule-node${path.length ? ' rule-node-nested' : ''}`}>
      <div className="rule-node-controls">
        <select aria-label="Success condition type" className="auth-input" value={rule.kind} onChange={(event) => selectKind(event.target.value)}>
          <option value="comparison">Metric comparison</option>
          {metric?.thresholds && <option value="threshold">Achievement threshold</option>}
          <option value="all">All conditions (AND)</option><option value="any">Any condition (OR)</option><option value="at-least">At least N conditions</option>
        </select>
        <InfoButton title="Condition type" summary="Choose how this success rule evaluates one or more conditions." description="Metric comparison checks a value directly. Achievement threshold checks the metric’s minimum, target, or stretch level. All (AND) requires every child rule; Any (OR) requires at least one; At least N lets you choose how many child rules must pass." />
        {onRemove && <Button type="button" variant="quiet" size="small" onClick={() => onRemove(path)}>Remove</Button>}
      </div>
      {(rule.kind === 'threshold' || rule.kind === 'comparison') && (
        <div className="rule-leaf-controls">
          <label className="form-field"><span>Measure <InfoButton title="Rule measure" summary="Choose which metric this condition evaluates." description="The selected metric supplies the value used by this condition. Rules evaluate a check-in; they do not change the recorded value or the goal’s total planning target." /></span>
            <select className="auth-input" value={rule.metricId} onChange={(event) => {
              const next = metrics.find((item) => item.id === event.target.value)
              if (next) onChange(path, defaultRule(next))
            }}>{metrics.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          </label>
          {rule.kind === 'threshold' && metric?.thresholds && <label className="form-field"><span>Level <InfoButton title="Achievement level" summary="Choose which configured threshold a check-in must meet." description="Minimum, target, and stretch are the per-check-in levels configured for the selected metric. Only levels that have a threshold value appear here." /></span>
            <select className="auth-input" value={rule.level} onChange={(event) => onChange(path, { ...rule, level: event.target.value as 'minimum' | 'target' | 'stretch' })}>
              {(['minimum', 'target', 'stretch'] as const).filter((level) => metric.thresholds?.[level] !== undefined).map((level) => <option key={level} value={level}>{level[0]?.toUpperCase()}{level.slice(1)}</option>)}
            </select>
          </label>}
          {rule.kind === 'comparison' && <>
            <label className="form-field"><span>Condition <InfoButton title="Comparison" summary="Choose the numeric or yes/no comparison to evaluate." description="At least and at most compare numeric values to the value below. Equals checks exact equality. For boolean values, choose whether completion should be true or false." /></span>
              <select className="auth-input" value={rule.operator} onChange={(event) => onChange(path, { ...rule, operator: event.target.value as 'equals' | 'at-least' | 'at-most' })}>
                {(metric?.valueType === 'boolean' ? ['equals'] : ['at-least', 'at-most', 'equals']).map((operator) => <option key={operator} value={operator}>{operator === 'at-least' ? 'At least' : operator === 'at-most' ? 'At most' : 'Equals'}</option>)}
              </select>
            </label>
            {metric?.valueType === 'boolean' ? <label className="form-field"><span>Value <InfoButton title="Comparison value" summary="Choose the value that makes this rule pass." description="For yes/no metrics select Completed or Not completed. For numeric metrics, enter the comparison boundary in that metric’s unit." /></span><select className="auth-input" value={String(rule.value)} onChange={(event) => onChange(path, { ...rule, value: event.target.value === 'true' })}><option value="true">Completed</option><option value="false">Not completed</option></select></label>
              : <label className="form-field"><span>Value <InfoButton title="Comparison value" summary="Enter the boundary for this numeric comparison." description="The condition compares a saved value to this number using the selected operator. The number uses the selected metric’s unit." /></span><input className="auth-input" type="number" step="any" value={typeof rule.value === 'number' ? rule.value : ''} onChange={(event) => onChange(path, { ...rule, value: Number(event.target.value) })} /></label>}
          </>}
        </div>
      )}
      {(rule.kind === 'all' || rule.kind === 'any' || rule.kind === 'at-least') && <div className="rule-operands">
        {rule.kind === 'at-least' && <label className="form-field rule-required"><span>Required conditions <InfoButton title="Required conditions" summary="Set how many child conditions must pass." description="Choose a number from one up to the number of listed conditions. The overall success rule qualifies when at least this many child conditions are true." /></span><input className="auth-input" type="number" min={1} max={rule.operands.length} value={rule.required} onChange={(event) => onChange(path, { ...rule, required: Math.min(rule.operands.length, Math.max(1, Number(event.target.value) || 1)) })} /></label>}
        {rule.operands.map((operand, index) => <RuleNode key={index} rule={operand} metrics={metrics} path={[...path, index]} onChange={changeOperand} onRemove={(childPath) => {
          const position = childPath.at(-1)
          if (position === undefined) return
          const remaining = rule.operands.filter((_, i) => i !== position)
          if (rule.kind === 'at-least' && remaining.length === 0) return
          if ((rule.kind === 'all' || rule.kind === 'any') && remaining.length < 2) {
            const collapse = remaining[0] ?? (metric ? defaultRule(metric) : null)
            if (collapse) onChange(path, collapse)
          } else onChange(path, { ...rule, operands: remaining, ...(rule.kind === 'at-least' ? { required: Math.min(rule.required, remaining.length) } : {}) })
        }} />)}
        <Button type="button" variant="quiet" size="small" onClick={() => metric && onChange(path, { ...rule, operands: [...rule.operands, defaultRule(metric)] })}>＋ Add condition</Button>
      </div>}
    </div>
  )
}

type Props = {
  section?: 'metrics' | 'rules' | 'fields' | 'milestones'
  metrics: TrackerMetricDefinition[]
  onMetricsChange: (metrics: TrackerMetricDefinition[]) => void
  rule?: TrackerRule
  onRuleChange: (rule: TrackerRule | undefined) => void
  customFields: CustomFieldDefinition[]
  onCustomFieldsChange: (fields: CustomFieldDefinition[]) => void
  milestones: TrackerMilestoneDefinition[]
  onMilestonesChange: (milestones: TrackerMilestoneDefinition[]) => void
}

export function TrackerConfigurationEditor({ section, metrics, onMetricsChange, rule, onRuleChange, customFields, onCustomFieldsChange, milestones, onMilestonesChange }: Props) {
  function updateMetric(id: string, changes: Partial<TrackerMetricDefinition>) {
    onMetricsChange(metrics.map((metric) => metric.id === id ? { ...metric, ...changes } : metric))
  }

  function changeMetricType(metric: TrackerMetricDefinition, type: TrackerMetricDefinition['valueType']) {
    updateMetric(metric.id, {
      valueType: type,
      unit: type === 'quantity' || type === 'duration' ? metric.unit ?? '' : undefined,
      thresholds: type === 'quantity' || type === 'duration' || type === 'checklist' ? metric.thresholds ?? { direction: 'increase', target: 1, streakQualification: 'any-recorded-value' } : undefined,
      precision: type === 'quantity' || type === 'duration' ? metric.precision : undefined,
      checklistItems: type === 'checklist' ? metric.checklistItems?.length ? metric.checklistItems : [{ id: crypto.randomUUID(), label: 'First item', position: 0 }] : undefined,
    })
  }

  function updateThreshold(metric: TrackerMetricDefinition, key: 'minimum' | 'target' | 'stretch' | 'direction' | 'streakQualification', raw: string) {
    const previous = metric.thresholds ?? { direction: 'increase' as const, streakQualification: 'any-recorded-value' as const }
    const next: ThresholdConfiguration = key === 'direction' ? { ...previous, direction: raw as 'increase' | 'decrease' }
      : key === 'streakQualification' ? { ...previous, streakQualification: raw as ThresholdConfiguration['streakQualification'] }
        : { ...previous, [key]: raw === '' ? undefined : Number(raw) }
    const qualifiesAt = next.streakQualification
    if ((qualifiesAt === 'minimum' && next.minimum === undefined) || (qualifiesAt === 'target' && next.target === undefined)) next.streakQualification = next.target !== undefined ? 'target' : next.minimum !== undefined ? 'minimum' : 'any-recorded-value'
    updateMetric(metric.id, { thresholds: next })
  }

  function removeMetric(id: string) {
    const next = metrics.filter((metric) => metric.id !== id)
    onMetricsChange(next)
    onRuleChange(undefined)
    onMilestonesChange(milestones.map((milestone) => milestone.metricId === id ? { ...milestone, metricId: undefined, targetValue: undefined } : milestone))
  }

  return (
    <div className="tracker-configuration">
      {(!section || section === 'metrics') && <section className="configuration-section" aria-labelledby="metrics-heading">
        <header className="configuration-heading"><div><h2 id="metrics-heading">Measures</h2><p>Choose what you record and define minimum, target, and stretch levels.</p></div><div className="dashboard-heading-actions"><InfoButton title="Measures and thresholds" summary="Measures are the values captured by each check-in; thresholds classify those values." description="Use separate measures for unlike quantities, such as pages and minutes. Yes/no records completion, quantity records a number, duration records time, and checklist records checked items. Minimum, target, and stretch describe one check-in only; they are separate from goal planning targets. Threshold direction controls whether higher or lower values count as better." /><Button type="button" variant="secondary" size="small" onClick={() => onMetricsChange([...metrics, freshMetric(metrics.length)])}>＋ Add measure</Button></div></header>
        {metrics.length === 0 && <p className="configuration-empty">Add at least one measure to record progress.</p>}
        {metrics.map((metric, index) => <article className="configuration-card" key={metric.id}>
          <header className="configuration-card-heading"><strong>Measure {index + 1}</strong>{metrics.length > 1 && <div><Button type="button" variant="quiet" size="small" disabled={ruleUsesMetric(rule, metric.id)} title={ruleUsesMetric(rule, metric.id) ? 'Remove linked success conditions first.' : undefined} onClick={() => removeMetric(metric.id)}>Remove</Button>{ruleUsesMetric(rule, metric.id) && <small className="field-hint">Remove linked success conditions first.</small>}</div>}</header>
          <div className="form-grid configuration-grid">
            <label className="form-field"><span>Name <InfoButton title="Measure name" summary="Name the value you plan to record." description="Examples include problems solved, reading, or workout duration. The name appears in check-in forms, history, analytics, and goal plans." /></span><input aria-label="Name" className="auth-input" maxLength={120} value={metric.name} onChange={(event) => updateMetric(metric.id, { name: event.target.value })} /></label>
            <label className="form-field"><span>Value type <InfoButton title="Value type" summary="Choose the shape of each recorded value." description="Yes/no stores a boolean completion. Quantity stores a number. Duration stores time as a number with a unit you choose. Checklist stores checked items and can be summarized as a count. Boolean measures do not support numeric planning targets." /></span><select aria-label={`Measure ${index + 1} value type`} className="auth-input" value={metric.valueType} onChange={(event) => changeMetricType(metric, event.target.value as TrackerMetricDefinition['valueType'])}><option value="boolean">Yes / no</option><option value="quantity">Quantity</option><option value="duration">Duration</option><option value="checklist">Checklist</option></select></label>
            {(metric.valueType === 'quantity' || metric.valueType === 'duration' || metric.valueType === 'checklist') && <>
              {metric.valueType !== 'checklist' && <label className="form-field"><span>Unit <InfoButton title="Unit" summary="Add the unit used to interpret the number." description="Examples: pages, sessions, kilometers, minutes, or hours. Separate metrics are never combined across different units." /></span><input className="auth-input" value={metric.unit ?? ''} onChange={(event) => updateMetric(metric.id, { unit: event.target.value })} placeholder={metric.valueType === 'duration' ? 'minutes, hours' : 'pages, sessions'} /></label>}
              {metric.valueType !== 'checklist' && <>
                <label className="form-field"><span>How can this measure be recorded? <InfoButton title="Numeric precision" summary="Choose the smallest permitted amount for new check-ins and plan suggestions." description="Whole numbers suit problems or books. One decimal place suits half-hour sessions. Two decimal places suits distances or quarter-hour amounts. Previously saved values remain unchanged; this setting does not rewrite history." /></span><select className="auth-input" aria-label={`${metric.name} recording precision`} value={metric.precision ? String(metric.precision.decimalPlaces) : ''} onChange={(event) => {
                  const places = event.target.value === '' ? undefined : Number(event.target.value) as 0 | 1 | 2
                  updateMetric(metric.id, { precision: places === undefined ? undefined : { decimalPlaces: places, increment: places === 0 ? 1 : places === 1 ? 0.5 : 0.25 } })
                }}><option value="">Keep existing precision</option><option value="0">Whole numbers</option><option value="1">One decimal place</option><option value="2">Up to two decimal places</option></select></label>
                {metric.precision && <label className="form-field"><span>Allowed increment <InfoButton title="Allowed increment" summary="Choose which values can be entered within the selected decimal precision." description="Decimal places set the maximum display precision; the increment sets allowed steps. For example, two decimal places with a 0.25 increment allows 0.25, 0.50, 0.75, and 1.00." /></span><select className="auth-input" aria-label={`${metric.name} allowed increment`} value={metric.precision.increment} onChange={(event) => updateMetric(metric.id, { precision: metric.precision ? { ...metric.precision, increment: Number(event.target.value) } : undefined })}>{(metric.precision.decimalPlaces === 0 ? [1] : metric.precision.decimalPlaces === 1 ? [0.1, 0.5] : [0.01, 0.05, 0.1, 0.25, 0.5]).map((increment) => <option key={increment} value={increment}>{increment}</option>)}</select></label>}
              </>}
              {metric.valueType === 'checklist' ? <div className="field-hint">Checklist thresholds use the count of completed items. Higher is better.</div> : <label className="form-field"><span>Threshold direction <InfoButton title="Threshold direction" summary="Choose whether a larger or smaller value represents progress." description="Higher is better suits totals like pages or steps. Lower is better suits measures like minutes spent or errors, where reducing the value is the aim. This direction affects threshold qualification and trend interpretation." /></span><select className="auth-input" value={metric.thresholds?.direction ?? 'increase'} onChange={(event) => updateThreshold(metric, 'direction', event.target.value)}><option value="increase">Higher is better</option><option value="decrease">Lower is better</option></select></label>}
              {(['minimum', 'target', 'stretch'] as const).map((level) => <label className="form-field" key={level}><span>{level[0]?.toUpperCase()}{level.slice(1)} threshold <em>optional</em> <InfoButton title={`${level[0]?.toUpperCase()}${level.slice(1)} threshold`} summary={`Set the ${level} for a single check-in.`} description={`Thresholds classify one recorded value. Minimum is a baseline, target is the intended result, and stretch is an ambitious result; none is the whole deadline total. Example: for 5 problems a day, set target 5 and stretch 8.`} /></span><input className="auth-input" type="number" step={metric.precision?.increment ?? 'any'} value={metric.thresholds?.[level] ?? ''} onChange={(event) => updateThreshold(metric, level, event.target.value)} /></label>)}
              <label className="form-field"><span>Streak qualifies at <InfoButton title="Streak qualification" summary="Choose the minimum result that keeps this metric’s streak going." description="Any recorded value qualifies when a value is saved. Minimum or target requires that level to be met. Example: with a 5-problem target, choosing a 1-problem minimum keeps the streak after one problem. Scheduled opportunities determine where a streak can grow; rest days are skipped." /></span><select className="auth-input" value={metric.thresholds?.streakQualification ?? 'any-recorded-value'} onChange={(event) => updateThreshold(metric, 'streakQualification', event.target.value)}><option value="any-recorded-value">Any recorded value</option>{metric.thresholds?.minimum !== undefined && <option value="minimum">Minimum</option>}{metric.thresholds?.target !== undefined && <option value="target">Target</option>}</select></label>
            </>}
            {metric.valueType === 'checklist' && <div className="form-field form-field-wide checklist-editor"><span>Checklist items <InfoButton title="Checklist items" summary="Define the items you can check off during a check-in." description="A checklist entry stores each item’s checked state. Thresholds and planning targets use the number of checked items. Daily checklist targets cannot exceed the number of defined items; cumulative goals may count incremental completed items across entries." /></span>{(metric.checklistItems ?? []).map((item, itemIndex) => <div className="inline-editor-row" key={item.id}><input aria-label={`Checklist item ${itemIndex + 1}`} className="auth-input" value={item.label} onChange={(event) => updateMetric(metric.id, { checklistItems: metric.checklistItems?.map((candidate) => candidate.id === item.id ? { ...candidate, label: event.target.value } : candidate) })} /><Button type="button" variant="quiet" size="small" onClick={() => updateMetric(metric.id, { checklistItems: metric.checklistItems?.filter((candidate) => candidate.id !== item.id).map((candidate, position) => ({ ...candidate, position })) })}>Remove</Button></div>)}<Button type="button" variant="quiet" size="small" onClick={() => updateMetric(metric.id, { checklistItems: [...(metric.checklistItems ?? []), { id: crypto.randomUUID(), label: '', position: metric.checklistItems?.length ?? 0 }] })}>＋ Add checklist item</Button></div>}
          </div>
        </article>)}
      </section>}

      {(!section || section === 'rules') && <section className="configuration-section" aria-labelledby="rule-heading">
        <header className="configuration-heading"><div><h2 id="rule-heading">Success rule</h2><p>Combine measure conditions with AND, OR, or an “at least” count.</p></div><div className="dashboard-heading-actions"><InfoButton title="Success rule" summary="Define what makes a check-in qualify as a success." description="A rule can compare a metric to a value or achievement threshold. Combine conditions using AND (all), OR (any), or At least N. Rules affect streaks and success summaries, not the saved entry itself or planning target totals." />{rule && <Button type="button" variant="quiet" size="small" onClick={() => onRuleChange(undefined)}>Clear rule</Button>}</div></header>
        {!rule && metrics.length > 0 && <Button type="button" variant="secondary" size="small" onClick={() => onRuleChange(defaultRule(metrics[0]!))}>＋ Add success rule</Button>}
        {rule && metrics.length > 0 && <RuleNode rule={rule} metrics={metrics} path={[]} onChange={(_, changed) => onRuleChange(changed)} />}
      </section>}

      {(!section || section === 'fields') && <section className="configuration-section" aria-labelledby="custom-fields-heading">
        <header className="configuration-heading"><div><h2 id="custom-fields-heading">Custom fields</h2><p>Optional details to capture alongside a future check-in.</p></div><div className="dashboard-heading-actions"><InfoButton title="Custom fields" summary="Capture context alongside a check-in without turning it into a progress metric." description="Custom fields can be text, numeric details, dates, selections, and other input types. They appear in future check-in forms. They do not automatically affect goal totals, thresholds, streaks, or success rules." /><Button type="button" variant="secondary" size="small" onClick={() => onCustomFieldsChange([...customFields, { id: crypto.randomUUID(), name: '', type: 'text', required: false, position: customFields.length }])}>＋ Add field</Button></div></header>
        {customFields.map((field) => <article className="configuration-card" key={field.id}><div className="form-grid configuration-grid">
          <label className="form-field"><span>Field name <InfoButton title="Custom field name" summary="Label the extra detail you want to record." description="This name appears on the check-in form and in saved history. Use a prompt such as “Where did I practice?” or “How was my energy?”" /></span><input aria-label="Field name" className="auth-input" value={field.name} onChange={(event) => onCustomFieldsChange(customFields.map((item) => item.id === field.id ? { ...item, name: event.target.value } : item))} /></label>
          <label className="form-field"><span>Field type <InfoButton title="Custom field type" summary="Choose how an optional check-in detail should be entered." description="Text, number, date, time, duration, selection, rating, and other types affect the input shown when you record a check-in. Custom fields are descriptive details and do not act as progress metrics or goal totals." /></span><select aria-label="Field type" className="auth-input" value={field.type} onChange={(event) => onCustomFieldsChange(customFields.map((item) => item.id === field.id ? { ...item, type: event.target.value as CustomFieldDefinition['type'], options: ['single-select', 'multi-select'].includes(event.target.value) ? item.options ?? ['Option 1'] : undefined } : item))}>{['text', 'long-text', 'integer', 'decimal', 'boolean', 'date', 'time', 'duration', 'single-select', 'multi-select', 'url', 'rating', 'quantity'].map((type) => <option key={type} value={type}>{type.replaceAll('-', ' ')}</option>)}</select></label>
          {['duration', 'quantity'].includes(field.type) && <label className="form-field"><span>Unit <em>optional</em> <InfoButton title="Custom field unit" summary="Name the unit for a custom numeric detail." description="This unit labels that detail in the form and history. It does not combine with tracker metrics or affect goal calculations." /></span><input className="auth-input" value={field.unit ?? ''} onChange={(event) => onCustomFieldsChange(customFields.map((item) => item.id === field.id ? { ...item, unit: event.target.value } : item))} /></label>}
          {(['single-select', 'multi-select'].includes(field.type)) && <label className="form-field form-field-wide"><span>Options <em>one per line</em> <InfoButton title="Selection options" summary="Provide the choices available for this custom field." description="Enter one option per line. Single-select allows one choice; multi-select allows several. Existing historical values are not rewritten when you edit these options." /></span><textarea className="auth-input tracker-textarea" value={(field.options ?? []).join('\n')} onChange={(event) => onCustomFieldsChange(customFields.map((item) => item.id === field.id ? { ...item, options: event.target.value.split('\n').map((option) => option.trim()).filter(Boolean) } : item))} /></label>}
          <label className="form-check"><input type="checkbox" checked={field.required} onChange={(event) => onCustomFieldsChange(customFields.map((item) => item.id === field.id ? { ...item, required: event.target.checked } : item))} />Required <InfoButton title="Required custom field" summary="Require a value before saving a new check-in." description="When enabled, the check-in form asks for this detail each time. This does not change old check-ins or goal qualification unless a separate success rule uses a metric." /></label>
          <Button type="button" variant="quiet" size="small" onClick={() => onCustomFieldsChange(customFields.filter((item) => item.id !== field.id).map((item, position) => ({ ...item, position })))}>Remove field</Button>
        </div></article>)}
      </section>}

      {(!section || section === 'milestones') && <section className="configuration-section" aria-labelledby="milestones-heading">
        <header className="configuration-heading"><div><h2 id="milestones-heading">Milestones</h2><p>Break a larger outcome into meaningful checkpoints.</p></div><div className="dashboard-heading-actions"><InfoButton title="Milestones" summary="Mark meaningful checkpoints along a larger goal." description="A milestone can have a title, optional date, optional linked metric and checkpoint value, and a descriptive note. Linked checkpoints compare against recorded values using that metric’s direction. Milestones do not create extra progress records." /><Button type="button" variant="secondary" size="small" onClick={() => onMilestonesChange([...milestones, { id: crypto.randomUUID(), title: '', description: '', position: milestones.length }])}>＋ Add milestone</Button></div></header>
        {milestones.map((milestone) => <article className="configuration-card" key={milestone.id}><div className="form-grid configuration-grid">
          <label className="form-field"><span>Milestone <InfoButton title="Milestone" summary="Name an important checkpoint along the way." description="Milestones break a larger goal into smaller outcomes. They are markers for progress, not separate trackers." /></span><input className="auth-input" value={milestone.title} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === milestone.id ? { ...item, title: event.target.value } : item))} /></label>
          <label className="form-field"><span>Due date <em>optional</em> <InfoButton title="Milestone due date" summary="Add a target date for this checkpoint." description="The date helps you see when a milestone is due. It is separate from the overall tracker deadline and uses a calendar date." /></span><input className="auth-input" type="date" value={milestone.dueDate ?? ''} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === milestone.id ? { ...item, dueDate: event.target.value || undefined } : item))} /></label>
          <label className="form-field"><span>Linked measure <em>optional</em> <InfoButton title="Linked measure" summary="Connect a milestone to one of the tracker’s metrics." description="A linked measure lets the goal page show the best observed value against the milestone checkpoint. Choose None for a descriptive milestone." /></span><select className="auth-input" value={milestone.metricId ?? ''} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === milestone.id ? { ...item, metricId: event.target.value || undefined } : item))}><option value="">None</option>{metrics.map((metric) => <option key={metric.id} value={metric.id}>{metric.name}</option>)}</select></label>
          {milestone.metricId && <label className="form-field"><span>Measure checkpoint <em>optional</em> <InfoButton title="Measure checkpoint" summary="Set the value that marks this linked milestone reached." description="The goal page compares the best recorded value for the linked metric with this checkpoint, respecting whether higher or lower is better. Example: enter 100 pages to mark the first 100 pages as a milestone." /></span><input className="auth-input" type="number" step="any" value={milestone.targetValue ?? ''} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === milestone.id ? { ...item, targetValue: event.target.value === '' ? undefined : Number(event.target.value) } : item))} /></label>}
          <label className="form-field form-field-wide"><span>Description <em>optional</em> <InfoButton title="Milestone description" summary="Add context for what this checkpoint means." description="This note appears with the milestone on your goal page. It is informational and does not affect qualification or calculations." /></span><textarea className="auth-input tracker-textarea" value={milestone.description} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === milestone.id ? { ...item, description: event.target.value } : item))} /></label>
          <Button type="button" variant="quiet" size="small" onClick={() => onMilestonesChange(milestones.filter((item) => item.id !== milestone.id).map((item, position) => ({ ...item, position })))}>Remove milestone</Button>
        </div></article>)}
      </section>}
    </div>
  )
}
