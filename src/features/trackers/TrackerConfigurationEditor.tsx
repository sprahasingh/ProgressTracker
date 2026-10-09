import type { CustomFieldDefinition, TrackerMetricDefinition, TrackerMilestoneDefinition, TrackerRule, ThresholdConfiguration } from '../../domain/trackers/types'
import { Button } from '../../components/ui/Button'

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
        {onRemove && <Button type="button" variant="quiet" size="small" onClick={() => onRemove(path)}>Remove</Button>}
      </div>
      {(rule.kind === 'threshold' || rule.kind === 'comparison') && (
        <div className="rule-leaf-controls">
          <label className="form-field"><span>Measure</span>
            <select className="auth-input" value={rule.metricId} onChange={(event) => {
              const next = metrics.find((item) => item.id === event.target.value)
              if (next) onChange(path, defaultRule(next))
            }}>{metrics.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          </label>
          {rule.kind === 'threshold' && metric?.thresholds && <label className="form-field"><span>Level</span>
            <select className="auth-input" value={rule.level} onChange={(event) => onChange(path, { ...rule, level: event.target.value as 'minimum' | 'target' | 'stretch' })}>
              {(['minimum', 'target', 'stretch'] as const).filter((level) => metric.thresholds?.[level] !== undefined).map((level) => <option key={level} value={level}>{level[0]?.toUpperCase()}{level.slice(1)}</option>)}
            </select>
          </label>}
          {rule.kind === 'comparison' && <>
            <label className="form-field"><span>Condition</span>
              <select className="auth-input" value={rule.operator} onChange={(event) => onChange(path, { ...rule, operator: event.target.value as 'equals' | 'at-least' | 'at-most' })}>
                {(metric?.valueType === 'boolean' ? ['equals'] : ['at-least', 'at-most', 'equals']).map((operator) => <option key={operator} value={operator}>{operator === 'at-least' ? 'At least' : operator === 'at-most' ? 'At most' : 'Equals'}</option>)}
              </select>
            </label>
            {metric?.valueType === 'boolean' ? <label className="form-field"><span>Value</span><select className="auth-input" value={String(rule.value)} onChange={(event) => onChange(path, { ...rule, value: event.target.value === 'true' })}><option value="true">Completed</option><option value="false">Not completed</option></select></label>
              : <label className="form-field"><span>Value</span><input className="auth-input" type="number" step="any" value={typeof rule.value === 'number' ? rule.value : ''} onChange={(event) => onChange(path, { ...rule, value: Number(event.target.value) })} /></label>}
          </>}
        </div>
      )}
      {(rule.kind === 'all' || rule.kind === 'any' || rule.kind === 'at-least') && <div className="rule-operands">
        {rule.kind === 'at-least' && <label className="form-field rule-required"><span>Required conditions</span><input className="auth-input" type="number" min={1} max={rule.operands.length} value={rule.required} onChange={(event) => onChange(path, { ...rule, required: Math.min(rule.operands.length, Math.max(1, Number(event.target.value) || 1)) })} /></label>}
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
  metrics: TrackerMetricDefinition[]
  onMetricsChange: (metrics: TrackerMetricDefinition[]) => void
  rule?: TrackerRule
  onRuleChange: (rule: TrackerRule | undefined) => void
  customFields: CustomFieldDefinition[]
  onCustomFieldsChange: (fields: CustomFieldDefinition[]) => void
  milestones: TrackerMilestoneDefinition[]
  onMilestonesChange: (milestones: TrackerMilestoneDefinition[]) => void
}

export function TrackerConfigurationEditor({ metrics, onMetricsChange, rule, onRuleChange, customFields, onCustomFieldsChange, milestones, onMilestonesChange }: Props) {
  function updateMetric(id: string, changes: Partial<TrackerMetricDefinition>) {
    onMetricsChange(metrics.map((metric) => metric.id === id ? { ...metric, ...changes } : metric))
  }

  function changeMetricType(metric: TrackerMetricDefinition, type: TrackerMetricDefinition['valueType']) {
    updateMetric(metric.id, {
      valueType: type,
      unit: type === 'quantity' || type === 'duration' ? metric.unit ?? '' : undefined,
      thresholds: type === 'quantity' || type === 'duration' || type === 'checklist' ? metric.thresholds ?? { direction: 'increase', target: 1, streakQualification: 'any-recorded-value' } : undefined,
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
      <section className="configuration-section" aria-labelledby="metrics-heading">
        <header className="configuration-heading"><div><h2 id="metrics-heading">Measures</h2><p>Choose what you record and define minimum, target, and stretch levels.</p></div><Button type="button" variant="secondary" size="small" onClick={() => onMetricsChange([...metrics, freshMetric(metrics.length)])}>＋ Add measure</Button></header>
        {metrics.length === 0 && <p className="configuration-empty">Add at least one measure to record progress.</p>}
        {metrics.map((metric, index) => <article className="configuration-card" key={metric.id}>
          <header className="configuration-card-heading"><strong>Measure {index + 1}</strong>{metrics.length > 1 && <div><Button type="button" variant="quiet" size="small" disabled={ruleUsesMetric(rule, metric.id)} title={ruleUsesMetric(rule, metric.id) ? 'Remove linked success conditions first.' : undefined} onClick={() => removeMetric(metric.id)}>Remove</Button>{ruleUsesMetric(rule, metric.id) && <small className="field-hint">Remove linked success conditions first.</small>}</div>}</header>
          <div className="form-grid configuration-grid">
            <label className="form-field"><span>Name</span><input className="auth-input" maxLength={120} value={metric.name} onChange={(event) => updateMetric(metric.id, { name: event.target.value })} /></label>
            <label className="form-field"><span>Value type</span><select aria-label={`Measure ${index + 1} value type`} className="auth-input" value={metric.valueType} onChange={(event) => changeMetricType(metric, event.target.value as TrackerMetricDefinition['valueType'])}><option value="boolean">Yes / no</option><option value="quantity">Quantity</option><option value="duration">Duration</option><option value="checklist">Checklist</option></select></label>
            {(metric.valueType === 'quantity' || metric.valueType === 'duration' || metric.valueType === 'checklist') && <>
              {metric.valueType !== 'checklist' && <label className="form-field"><span>Unit</span><input className="auth-input" value={metric.unit ?? ''} onChange={(event) => updateMetric(metric.id, { unit: event.target.value })} placeholder={metric.valueType === 'duration' ? 'minutes, hours' : 'pages, sessions'} /></label>}
              {metric.valueType === 'checklist' ? <div className="field-hint">Checklist thresholds use the count of completed items. Higher is better.</div> : <label className="form-field"><span>Threshold direction</span><select className="auth-input" value={metric.thresholds?.direction ?? 'increase'} onChange={(event) => updateThreshold(metric, 'direction', event.target.value)}><option value="increase">Higher is better</option><option value="decrease">Lower is better</option></select></label>}
              {(['minimum', 'target', 'stretch'] as const).map((level) => <label className="form-field" key={level}><span>{level[0]?.toUpperCase()}{level.slice(1)} threshold <em>optional</em></span><input className="auth-input" type="number" step="any" value={metric.thresholds?.[level] ?? ''} onChange={(event) => updateThreshold(metric, level, event.target.value)} /></label>)}
              <label className="form-field"><span>Streak qualifies at</span><select className="auth-input" value={metric.thresholds?.streakQualification ?? 'any-recorded-value'} onChange={(event) => updateThreshold(metric, 'streakQualification', event.target.value)}><option value="any-recorded-value">Any recorded value</option>{metric.thresholds?.minimum !== undefined && <option value="minimum">Minimum</option>}{metric.thresholds?.target !== undefined && <option value="target">Target</option>}</select></label>
            </>}
            {metric.valueType === 'checklist' && <div className="form-field form-field-wide checklist-editor"><span>Checklist items</span>{(metric.checklistItems ?? []).map((item, itemIndex) => <div className="inline-editor-row" key={item.id}><input aria-label={`Checklist item ${itemIndex + 1}`} className="auth-input" value={item.label} onChange={(event) => updateMetric(metric.id, { checklistItems: metric.checklistItems?.map((candidate) => candidate.id === item.id ? { ...candidate, label: event.target.value } : candidate) })} /><Button type="button" variant="quiet" size="small" onClick={() => updateMetric(metric.id, { checklistItems: metric.checklistItems?.filter((candidate) => candidate.id !== item.id).map((candidate, position) => ({ ...candidate, position })) })}>Remove</Button></div>)}<Button type="button" variant="quiet" size="small" onClick={() => updateMetric(metric.id, { checklistItems: [...(metric.checklistItems ?? []), { id: crypto.randomUUID(), label: '', position: metric.checklistItems?.length ?? 0 }] })}>＋ Add checklist item</Button></div>}
          </div>
        </article>)}
      </section>

      <section className="configuration-section" aria-labelledby="rule-heading">
        <header className="configuration-heading"><div><h2 id="rule-heading">Success rule</h2><p>Combine measure conditions with AND, OR, or an “at least” count.</p></div>{rule && <Button type="button" variant="quiet" size="small" onClick={() => onRuleChange(undefined)}>Clear rule</Button>}</header>
        {!rule && metrics.length > 0 && <Button type="button" variant="secondary" size="small" onClick={() => onRuleChange(defaultRule(metrics[0]!))}>＋ Add success rule</Button>}
        {rule && metrics.length > 0 && <RuleNode rule={rule} metrics={metrics} path={[]} onChange={(_, changed) => onRuleChange(changed)} />}
      </section>

      <section className="configuration-section" aria-labelledby="custom-fields-heading">
        <header className="configuration-heading"><div><h2 id="custom-fields-heading">Custom fields</h2><p>Optional details to capture alongside a future check-in.</p></div><Button type="button" variant="secondary" size="small" onClick={() => onCustomFieldsChange([...customFields, { id: crypto.randomUUID(), name: '', type: 'text', required: false, position: customFields.length }])}>＋ Add field</Button></header>
        {customFields.map((field) => <article className="configuration-card" key={field.id}><div className="form-grid configuration-grid">
          <label className="form-field"><span>Field name</span><input className="auth-input" value={field.name} onChange={(event) => onCustomFieldsChange(customFields.map((item) => item.id === field.id ? { ...item, name: event.target.value } : item))} /></label>
          <label className="form-field"><span>Field type</span><select className="auth-input" value={field.type} onChange={(event) => onCustomFieldsChange(customFields.map((item) => item.id === field.id ? { ...item, type: event.target.value as CustomFieldDefinition['type'], options: ['single-select', 'multi-select'].includes(event.target.value) ? item.options ?? ['Option 1'] : undefined } : item))}>{['text', 'long-text', 'integer', 'decimal', 'boolean', 'date', 'time', 'duration', 'single-select', 'multi-select', 'url', 'rating', 'quantity'].map((type) => <option key={type} value={type}>{type.replaceAll('-', ' ')}</option>)}</select></label>
          {['duration', 'quantity'].includes(field.type) && <label className="form-field"><span>Unit <em>optional</em></span><input className="auth-input" value={field.unit ?? ''} onChange={(event) => onCustomFieldsChange(customFields.map((item) => item.id === field.id ? { ...item, unit: event.target.value } : item))} /></label>}
          {(['single-select', 'multi-select'].includes(field.type)) && <label className="form-field form-field-wide"><span>Options <em>one per line</em></span><textarea className="auth-input tracker-textarea" value={(field.options ?? []).join('\n')} onChange={(event) => onCustomFieldsChange(customFields.map((item) => item.id === field.id ? { ...item, options: event.target.value.split('\n').map((option) => option.trim()).filter(Boolean) } : item))} /></label>}
          <label className="form-check"><input type="checkbox" checked={field.required} onChange={(event) => onCustomFieldsChange(customFields.map((item) => item.id === field.id ? { ...item, required: event.target.checked } : item))} />Required</label>
          <Button type="button" variant="quiet" size="small" onClick={() => onCustomFieldsChange(customFields.filter((item) => item.id !== field.id).map((item, position) => ({ ...item, position })))}>Remove field</Button>
        </div></article>)}
      </section>

      <section className="configuration-section" aria-labelledby="milestones-heading">
        <header className="configuration-heading"><div><h2 id="milestones-heading">Milestones</h2><p>Break a larger outcome into meaningful checkpoints.</p></div><Button type="button" variant="secondary" size="small" onClick={() => onMilestonesChange([...milestones, { id: crypto.randomUUID(), title: '', description: '', position: milestones.length }])}>＋ Add milestone</Button></header>
        {milestones.map((milestone) => <article className="configuration-card" key={milestone.id}><div className="form-grid configuration-grid">
          <label className="form-field"><span>Milestone</span><input className="auth-input" value={milestone.title} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === milestone.id ? { ...item, title: event.target.value } : item))} /></label>
          <label className="form-field"><span>Due date <em>optional</em></span><input className="auth-input" type="date" value={milestone.dueDate ?? ''} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === milestone.id ? { ...item, dueDate: event.target.value || undefined } : item))} /></label>
          <label className="form-field"><span>Linked measure <em>optional</em></span><select className="auth-input" value={milestone.metricId ?? ''} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === milestone.id ? { ...item, metricId: event.target.value || undefined } : item))}><option value="">None</option>{metrics.map((metric) => <option key={metric.id} value={metric.id}>{metric.name}</option>)}</select></label>
          {milestone.metricId && <label className="form-field"><span>Measure checkpoint <em>optional</em></span><input className="auth-input" type="number" step="any" value={milestone.targetValue ?? ''} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === milestone.id ? { ...item, targetValue: event.target.value === '' ? undefined : Number(event.target.value) } : item))} /></label>}
          <label className="form-field form-field-wide"><span>Description <em>optional</em></span><textarea className="auth-input tracker-textarea" value={milestone.description} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === milestone.id ? { ...item, description: event.target.value } : item))} /></label>
          <Button type="button" variant="quiet" size="small" onClick={() => onMilestonesChange(milestones.filter((item) => item.id !== milestone.id).map((item, position) => ({ ...item, position })))}>Remove milestone</Button>
        </div></article>)}
      </section>
    </div>
  )
}
