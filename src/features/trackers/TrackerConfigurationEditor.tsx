import { useState } from 'react'
import type { CustomFieldDefinition, GoalPlanningConfiguration, TrackerMetricDefinition, TrackerMilestoneDefinition, TrackerMilestoneType, TrackerRule, TrackerStreakRuleMode, ThresholdConfiguration } from '../../domain/trackers/types'
import { Button } from '../../components/ui/Button'
import { InfoButton } from '../../components/ui/InfoButton'
import { SectionHeader } from '../../components/ui/SectionHeader'
import { isSchemaV4WriteEnabled } from '../../domain/trackers/schemaVersionGate'
import { AppIcon } from '../../components/ui/AppIcon'
import { activeTrackerMetrics } from '../../domain/trackers/types'
import { availableMilestoneTypes, milestoneConfigurationIssue, milestonePreview, milestoneTargetLabel, milestoneTypeLabel, type MilestoneConfigurationContext } from '../../domain/trackers/milestones'

function freshMetric(index: number): TrackerMetricDefinition {
  return { id: crypto.randomUUID(), name: `Measure ${index + 1}`, valueType: 'quantity', unit: '', thresholds: { direction: 'increase', streakQualification: 'any-recorded-value' } }
}

function defaultRule(metric: TrackerMetricDefinition): TrackerRule {
  if (metric.thresholds?.target !== undefined) return { kind: 'threshold', metricId: metric.id, level: 'target' }
  if (metric.thresholds?.minimum !== undefined) return { kind: 'threshold', metricId: metric.id, level: 'minimum' }
  return metric.valueType === 'boolean'
    ? { kind: 'comparison', metricId: metric.id, operator: 'equals', value: true }
    : { kind: 'comparison', metricId: metric.id, operator: 'at-least', value: 1 }
}

function ruleUsesMetric(rule: TrackerRule | undefined, metricId: string): boolean {
  if (!rule) return false
  if (rule.kind === 'threshold' || rule.kind === 'comparison') return rule.metricId === metricId
  return rule.operands.some((operand) => ruleUsesMetric(operand, metricId))
}

function replaceRuleMetric(rule: TrackerRule | undefined, metricId: string, metric: TrackerMetricDefinition): TrackerRule | undefined {
  if (!rule) return undefined
  if (rule.kind === 'threshold' || rule.kind === 'comparison') return rule.metricId === metricId ? defaultRule(metric) : rule
  return { ...rule, operands: rule.operands.map((operand) => replaceRuleMetric(operand, metricId, metric)!) }
}

type RuleNodeProps = { rule: TrackerRule; metrics: TrackerMetricDefinition[]; path: number[]; onChange: (path: number[], rule: TrackerRule) => void; onRemove?: (path: number[]) => void; ruleName: 'Success' | 'Streak'; pathRoot: 'qualificationRule' | 'streakRule' }

function RuleNode({ rule, metrics, path, onChange, onRemove, ruleName, pathRoot }: RuleNodeProps) {
  // A saved greater-than-zero comparison gets the friendly preset label when
  // reopened. Keep an in-session choice of the generic operator visible while
  // its boundary is still zero so the user can edit it without the select
  // snapping back to the preset.
  const [customGreaterThan, setCustomGreaterThan] = useState(false)
  const validationPath = `${pathRoot}${path.map((index) => `.operands.${index}`).join('')}`
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
      onChange(path, { kind, metricId: metric.id, operator: metric.valueType === 'boolean' ? 'equals' : 'at-least', value: metric.valueType === 'boolean' ? true : 1 })
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
        <select data-validation-path={validationPath} aria-label={`${ruleName} condition type`} className="auth-input" value={rule.kind} onChange={(event) => selectKind(event.target.value)}>
          <option value="comparison">Metric comparison</option>
          {metric && (['minimum', 'target', 'stretch'] as const).some((level) => metric.thresholds?.[level] !== undefined) && <option value="threshold">Achievement threshold</option>}
          <option value="all">All conditions (AND)</option><option value="any">Any condition (OR)</option><option value="at-least">At least N conditions</option>
        </select>
        <InfoButton title="Condition type" summary={`Choose how this ${ruleName.toLowerCase()} rule evaluates one or more conditions.`} description="Metric comparison checks a value directly. Achievement threshold checks the metric’s minimum, target, or stretch level. All (AND) requires every child rule; Any (OR) requires at least one; At least N lets you choose how many child rules must pass." />
        {onRemove && <Button type="button" variant="destructive" size="small" onClick={() => onRemove(path)}>Remove</Button>}
      </div>
      {(rule.kind === 'threshold' || rule.kind === 'comparison') && (
        <div className="rule-leaf-controls">
          <label className="form-field"><span>Measure <InfoButton title="Rule measure" summary="Choose which metric this condition evaluates." description="The selected metric supplies the value used by this condition. Rules evaluate a check-in; they do not change the recorded value or the goal’s total planning target." /></span>
            <select aria-label="Measure" data-validation-path={validationPath} className="auth-input" value={rule.metricId} onChange={(event) => {
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
            <label className="form-field"><span>Condition <InfoButton title="Comparison" summary="Choose the numeric, checklist-count, or yes/no comparison to evaluate." description="Greater than, at least, and at most compare a quantity or duration value, or the number of checked checklist items, with the value below. Any positive value means a quantity or duration above zero or at least one checked checklist item. Equals checks exact equality. For boolean values, choose whether completion should be true or false." /></span>
              <select aria-label="Condition" className="auth-input" value={pathRoot === 'streakRule' && !customGreaterThan && rule.operator === 'greater-than' && rule.value === 0 ? 'positive-value' : rule.operator} onChange={(event) => {
                const selected = event.target.value
                if (selected === 'positive-value') {
                  setCustomGreaterThan(false)
                  onChange(path, { ...rule, operator: 'greater-than', value: 0 })
                } else {
                  setCustomGreaterThan(selected === 'greater-than')
                  onChange(path, { ...rule, operator: selected as 'equals' | 'greater-than' | 'at-least' | 'at-most' })
                }
              }}>
                {metric?.valueType === 'boolean'
                  ? <option value="equals">Equals</option>
                  : <>
                    {pathRoot === 'streakRule' && <option value="positive-value">Any positive value (&gt; 0)</option>}
                    {pathRoot === 'streakRule' && <option value="greater-than">Greater than</option>}
                    <option value="at-least">At least</option><option value="at-most">At most</option><option value="equals">Equals</option>
                  </>}
              </select>
            </label>
            {metric?.valueType === 'boolean' ? <label className="form-field"><span>Value <InfoButton title="Comparison value" summary="Choose the value that makes this rule pass." description="For yes/no metrics select Completed or Not completed. For numeric metrics, enter the comparison boundary in that metric’s unit." /></span><select aria-label="Value" className="auth-input" value={String(rule.value)} onChange={(event) => onChange(path, { ...rule, value: event.target.value === 'true' })}><option value="true">Completed</option><option value="false">Not completed</option></select></label>
              : <label className="form-field"><span>Value <InfoButton title="Comparison value" summary="Enter the boundary for this numeric comparison." description="The condition compares a saved value to this number using the selected operator. The number uses the selected metric’s unit." /></span><input aria-label="Value" data-validation-path={`${validationPath}.value`} className="auth-input" type="number" min="0" step="any" value={typeof rule.value === 'number' ? rule.value : ''} onChange={(event) => onChange(path, { ...rule, value: Number(event.target.value) })} /></label>}
          </>}
        </div>
      )}
      {(rule.kind === 'all' || rule.kind === 'any' || rule.kind === 'at-least') && <div className="rule-operands">
        {rule.kind === 'at-least' && <label className="form-field rule-required"><span>Required conditions <InfoButton title="Required conditions" summary="Set how many child conditions must pass." description="Choose a number from one up to the number of listed conditions. The overall success rule qualifies when at least this many child conditions are true." /></span><input data-validation-path={`${validationPath}.required`} className="auth-input" type="number" min={1} max={rule.operands.length} value={rule.required} onChange={(event) => onChange(path, { ...rule, required: Math.min(rule.operands.length, Math.max(1, Number(event.target.value) || 1)) })} /></label>}
        {rule.operands.map((operand, index) => <RuleNode key={index} rule={operand} metrics={metrics} path={[...path, index]} onChange={changeOperand} ruleName={ruleName} pathRoot={pathRoot} onRemove={(childPath) => {
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
  section?: 'metrics' | 'rules' | 'streak-rules' | 'fields' | 'milestones'
  metrics: TrackerMetricDefinition[]
  onMetricsChange: (metrics: TrackerMetricDefinition[]) => void
  rule?: TrackerRule
  onRuleChange: (rule: TrackerRule | undefined) => void
  customFields: CustomFieldDefinition[]
  onCustomFieldsChange: (fields: CustomFieldDefinition[]) => void
  milestones: TrackerMilestoneDefinition[]
  onMilestonesChange: (milestones: TrackerMilestoneDefinition[]) => void
  firstMetricTypeMode?: 'setup' | 'locked'
  persistedMetricIds?: string[]
  metricsWithHistory?: string[]
  onRemoveMetric?: (id: string) => void
  planning?: GoalPlanningConfiguration
  streakRuleMode?: TrackerStreakRuleMode | 'legacy'
  streakRule?: TrackerRule
  onStreakRuleModeChange?: (mode: TrackerStreakRuleMode | 'legacy') => void
  onStreakRuleChange?: (rule: TrackerRule | undefined) => void
  milestoneContext?: MilestoneConfigurationContext
}

function ruleSummary(rule: TrackerRule, metrics: readonly TrackerMetricDefinition[]): string {
  const metricName = (id: string) => metrics.find((metric) => metric.id === id)?.name ?? 'Unknown measure'
  if (rule.kind === 'threshold') return `${metricName(rule.metricId)} meets its ${rule.level} threshold`
  if (rule.kind === 'comparison') {
    const metric = metrics.find((item) => item.id === rule.metricId)
    if (rule.operator === 'greater-than' && rule.value === 0) return `${metricName(rule.metricId)} has any positive value`
    const operator = rule.operator === 'greater-than' ? '>' : rule.operator === 'at-least' ? '≥' : rule.operator === 'at-most' ? '≤' : '='
    const value = typeof rule.value === 'boolean' ? rule.value ? 'Yes' : 'No' : `${rule.value}${metric?.unit ? ` ${metric.unit}` : ''}`
    return `${metricName(rule.metricId)} ${operator} ${value}`
  }
  const parts = rule.operands.map((operand) => ruleSummary(operand, metrics))
  if (rule.kind === 'at-least') return `At least ${rule.required} of (${parts.join('; ')})`
  return `(${parts.join(rule.kind === 'all' ? ' AND ' : ' OR ')})`
}

function milestoneMeasureIsCompatible(type: TrackerMilestoneType | 'legacy', metric: TrackerMetricDefinition): boolean {
  if (type === 'cumulative-quantity' || type === 'single-day-quantity') return metric.valueType === 'quantity' || metric.valueType === 'duration'
  if (type === 'measure-completion-count') return metric.valueType === 'boolean' || metric.valueType === 'checklist'
  return type === 'legacy'
}

function milestoneMeasureSnapshot(type: TrackerMilestoneType, metric: TrackerMetricDefinition | undefined) {
  if (!metric || !milestoneMeasureIsCompatible(type, metric)) return { metricId: undefined, measureTypeSnapshot: undefined, unitSnapshot: undefined, completionCondition: undefined, checklistItemId: undefined, checklistItemLabelSnapshot: undefined, checklistItemsSnapshot: undefined }
  if (type === 'cumulative-quantity' || type === 'single-day-quantity') return { metricId: metric.id, measureTypeSnapshot: metric.valueType, unitSnapshot: metric.unit ?? '', completionCondition: undefined, checklistItemId: undefined, checklistItemLabelSnapshot: undefined, checklistItemsSnapshot: undefined }
  if (type === 'measure-completion-count' && metric.valueType === 'boolean') return { metricId: metric.id, measureTypeSnapshot: 'boolean' as const, completionCondition: 'true-day' as const, checklistItemId: undefined, checklistItemLabelSnapshot: undefined, checklistItemsSnapshot: undefined }
  if (type === 'measure-completion-count' && metric.valueType === 'checklist') {
    const item = metric.checklistItems?.[0]
    return { metricId: metric.id, measureTypeSnapshot: 'checklist' as const, completionCondition: 'checklist-item-day' as const, checklistItemId: item?.id, checklistItemLabelSnapshot: item?.label, checklistItemsSnapshot: metric.checklistItems?.map((checklistItem) => checklistItem.id) ?? [] }
  }
  return { metricId: undefined, measureTypeSnapshot: undefined, unitSnapshot: undefined, completionCondition: undefined, checklistItemId: undefined, checklistItemLabelSnapshot: undefined, checklistItemsSnapshot: undefined }
}

function createMilestone(type: TrackerMilestoneType, metrics: TrackerMetricDefinition[], position: number): TrackerMilestoneDefinition {
  const compatible = activeTrackerMetrics(metrics).filter((metric) => milestoneMeasureIsCompatible(type, metric))
  return {
    id: crypto.randomUUID(), title: '', description: '', type,
    ...milestoneMeasureSnapshot(type, compatible[0]),
    position,
  }
}

function defaultMilestoneType(context: MilestoneConfigurationContext): TrackerMilestoneType | undefined {
  const metrics = activeTrackerMetrics(context.metrics)
  if (metrics.some((metric) => metric.valueType === 'quantity' || metric.valueType === 'duration')) return 'cumulative-quantity'
  if (metrics.some((metric) => metric.valueType === 'boolean' || metric.valueType === 'checklist')) return 'measure-completion-count'
  return availableMilestoneTypes(context)[0]
}

function MilestoneEditor({ metrics, milestones, onMilestonesChange, context, section }: {
  metrics: TrackerMetricDefinition[]
  milestones: TrackerMilestoneDefinition[]
  onMilestonesChange: (milestones: TrackerMilestoneDefinition[]) => void
  context: MilestoneConfigurationContext
  section?: 'milestones'
}) {
  const availableTypes = availableMilestoneTypes(context)
  const defaultType = defaultMilestoneType(context)
  const update = (id: string, changes: Partial<TrackerMilestoneDefinition>) => onMilestonesChange(milestones.map((item) => item.id === id ? { ...item, ...changes } : item))

  function addMilestone() {
    if (!defaultType) return
    onMilestonesChange([...milestones, createMilestone(defaultType, metrics, milestones.length)])
  }

  function changeType(milestone: TrackerMilestoneDefinition, requested: string) {
    if (requested === 'legacy' || requested === milestone.type || !availableTypes.includes(requested as TrackerMilestoneType)) return
    if (milestone.targetValue !== undefined && !window.confirm('Changing what this milestone measures can change its progress and completion. The old target will be cleared so you can enter a value for the new meaning. Continue?')) return
    const type = requested as TrackerMilestoneType
    const currentMeasure = metrics.find((item) => item.id === milestone.metricId)
    const compatibleMeasure = currentMeasure && milestoneMeasureIsCompatible(type, currentMeasure) && !currentMeasure.retiredAt
      ? currentMeasure
      : activeTrackerMetrics(metrics).find((item) => milestoneMeasureIsCompatible(type, item))
    const snapshot = milestoneMeasureSnapshot(type, compatibleMeasure)
    update(milestone.id, { type, ...snapshot, targetValue: undefined })
  }

  function changeMeasure(milestone: TrackerMilestoneDefinition, metricId: string) {
    const metric = metrics.find((item) => item.id === metricId)
    if (!metric) return
    if (milestone.metricId !== metricId && milestone.targetValue !== undefined && !window.confirm('Changing the measure can change this milestone’s progress and completion. The target will be cleared so you can enter it in the selected measure’s unit. Continue?')) return
    if (milestone.type === undefined) {
      update(milestone.id, { metricId: metricId || undefined })
      return
    }
    update(milestone.id, { ...milestoneMeasureSnapshot(milestone.type, metric), targetValue: milestone.metricId === metricId ? milestone.targetValue : undefined })
  }

  function changeChecklistCondition(milestone: TrackerMilestoneDefinition, condition: 'checklist-item-day' | 'checklist-complete-day', metric: TrackerMetricDefinition) {
    if (condition === 'checklist-item-day') {
      const item = metric.checklistItems?.find((candidate) => candidate.id === milestone.checklistItemId) ?? metric.checklistItems?.[0]
      update(milestone.id, { completionCondition: condition, checklistItemId: item?.id, checklistItemLabelSnapshot: item?.label, checklistItemsSnapshot: metric.checklistItems?.map((candidate) => candidate.id) ?? [] })
    } else update(milestone.id, { completionCondition: condition, checklistItemId: undefined, checklistItemLabelSnapshot: undefined, checklistItemsSnapshot: metric.checklistItems?.map((candidate) => candidate.id) ?? [] })
  }

  return <section data-validation-path="milestones" className="configuration-section" aria-label="Milestones">
    <SectionHeader title={section ? undefined : 'Milestones'} headingId={section ? undefined : 'milestones-heading'} description="Set a clear target and see exactly how its progress is calculated." help={{ title: 'Milestones', summary: 'Small, measurable checkpoints inside a tracker.', description: 'Each new milestone names the measure, target, and calculation. Historical progress is derived from saved check-ins. Older checkpoints keep their original best-observation calculation until you intentionally convert them.' }} action={<Button type="button" variant="secondary" size="small" disabled={!defaultType} onClick={addMilestone}>＋ Add milestone</Button>} />
    {!defaultType && milestones.length === 0 && <p className="field-hint">Add an active measure or set a fixed challenge duration to create a measurable milestone.</p>}
    {milestones.map((milestone, index) => {
      const type = milestone.type ?? 'legacy'
      const currentMetric = metrics.find((item) => item.id === milestone.metricId)
      const typeOptions = [...availableTypes]
      if (milestone.type && !typeOptions.includes(milestone.type)) typeOptions.push(milestone.type)
      const optionsForType = type === 'legacy' ? metrics
        : activeTrackerMetrics(metrics).filter((metric) => milestoneMeasureIsCompatible(type, metric))
      const measureOptions = [...new Map([...(currentMetric ? [[currentMetric.id, currentMetric] as const] : []), ...optionsForType.map((metric) => [metric.id, metric] as const)]).values()]
      const canSelectMeasure = type === 'legacy' || type === 'cumulative-quantity' || type === 'single-day-quantity' || type === 'measure-completion-count'
      const issue = type === 'legacy' ? null : currentMetric ? milestoneConfigurationIssue(milestone, currentMetric) : canSelectMeasure ? 'Choose a measure for this milestone.' : null
      const unavailableType = milestone.type !== undefined && !availableTypes.includes(milestone.type)
      const targetLabel = milestoneTargetLabel(type, currentMetric)
      const integerTarget = ['successful-days', 'streak-length', 'challenge-day', 'measure-completion-count'].includes(type)
      return <article className="configuration-card milestone-editor-card" key={milestone.id}>
        <div className="form-grid configuration-grid">
          <label className="form-field"><span>Milestone name</span><input data-validation-path={`milestones.${index}.title`} className="auth-input" value={milestone.title} onChange={(event) => update(milestone.id, { title: event.target.value })} placeholder="First 50 problems" /></label>
          <label className="form-field"><span>What should this milestone track?</span><select data-validation-path={`milestones.${index}.type`} className="auth-input" value={type} onChange={(event) => changeType(milestone, event.target.value)}>
            {milestone.type === undefined && <option value="legacy">{milestoneTypeLabel('legacy')}</option>}
            {typeOptions.map((option) => <option key={option} value={option}>{milestoneTypeLabel(option)}{option === milestone.type && unavailableType ? ' · needs review' : ''}</option>)}
          </select></label>
          {canSelectMeasure && <label className="form-field"><span>Which measure?{type === 'legacy' && <em>optional</em>}</span><select data-validation-path={`milestones.${index}.metricId`} className="auth-input" value={milestone.metricId ?? ''} onChange={(event) => changeMeasure(milestone, event.target.value)}>
            {type === 'legacy' && <option value="">No measure</option>}
            {measureOptions.map((metric) => <option key={metric.id} value={metric.id}>{metric.name}{metric.retiredAt ? ' · retired' : ''}{!milestoneMeasureIsCompatible(type, metric) && type !== 'legacy' ? ' · needs review' : ''}</option>)}
          </select></label>}
          {canSelectMeasure && !measureOptions.some((metric) => !metric.retiredAt && milestoneMeasureIsCompatible(type, metric)) && type !== 'legacy' && <p className="field-hint form-field-wide">Add an active compatible measure before using this milestone type.</p>}
          {type === 'measure-completion-count' && currentMetric?.valueType === 'checklist' && <>
            <label className="form-field"><span>What counts as complete?</span><select className="auth-input" value={milestone.completionCondition === 'checklist-complete-day' ? 'checklist-complete-day' : 'checklist-item-day'} onChange={(event) => changeChecklistCondition(milestone, event.target.value as 'checklist-item-day' | 'checklist-complete-day', currentMetric)}><option value="checklist-item-day">A selected checklist item</option><option value="checklist-complete-day">The full checklist</option></select></label>
            {milestone.completionCondition !== 'checklist-complete-day' && <label className="form-field"><span>Checklist item</span><select data-validation-path={`milestones.${index}.checklistItemId`} className="auth-input" value={milestone.checklistItemId ?? ''} onChange={(event) => {
              const item = currentMetric.checklistItems?.find((candidate) => candidate.id === event.target.value)
              update(milestone.id, { checklistItemId: item?.id, checklistItemLabelSnapshot: item?.label, checklistItemsSnapshot: currentMetric.checklistItems?.map((candidate) => candidate.id) ?? [] })
            }}>{currentMetric.checklistItems?.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
          </>}
          {type !== 'legacy' && <label className="form-field"><span>{targetLabel}</span><input data-validation-path={`milestones.${index}.targetValue`} className="auth-input" type="number" min={integerTarget ? 1 : currentMetric?.precision?.increment} max={Number.MAX_SAFE_INTEGER} step={integerTarget ? 1 : currentMetric?.precision?.increment ?? 'any'} value={milestone.targetValue ?? ''} onChange={(event) => update(milestone.id, { targetValue: event.target.value === '' ? undefined : Number(event.target.value) })} /></label>}
          {type === 'legacy' && milestone.metricId && <label className="form-field"><span>Saved measure checkpoint</span><input data-validation-path={`milestones.${index}.targetValue`} className="auth-input" type="number" min="0" step={currentMetric?.valueType === 'boolean' || currentMetric?.valueType === 'checklist' ? 1 : currentMetric?.precision?.increment ?? 'any'} value={milestone.targetValue ?? ''} onChange={(event) => update(milestone.id, { targetValue: event.target.value === '' ? undefined : Number(event.target.value) })} /></label>}
          <label className="form-field"><span>Due date <em>optional</em></span><input data-validation-path={`milestones.${index}.dueDate`} className="auth-input" type="date" value={milestone.dueDate ?? ''} onChange={(event) => update(milestone.id, { dueDate: event.target.value || undefined })} /></label>
          <label className="form-field form-field-wide"><span>Description <em>optional</em></span><textarea className="auth-input tracker-textarea" value={milestone.description} onChange={(event) => update(milestone.id, { description: event.target.value })} /></label>
          <p className="milestone-live-preview form-field-wide" aria-live="polite"><strong>Preview:</strong> {milestonePreview(context, milestone)}</p>
          {issue && <p className="milestone-configuration-issue form-field-wide" role="status">{issue}</p>}
          {unavailableType && !issue && <p className="milestone-configuration-issue form-field-wide" role="status">This milestone type no longer matches the tracker’s current setup. Choose a supported type to continue.</p>}
          {currentMetric && (type === 'cumulative-quantity' || type === 'single-day-quantity') && milestone.measureTypeSnapshot === currentMetric.valueType && milestone.unitSnapshot !== (currentMetric.unit ?? '') && <div className="form-field-wide"><Button type="button" variant="secondary" size="small" onClick={() => {
            if (window.confirm('Updating the saved unit keeps the numeric target but changes the unit it represents. Review that target before continuing. Update the unit?')) update(milestone.id, { unitSnapshot: currentMetric.unit ?? '' })
          }}>Review target in {currentMetric.unit?.trim() || 'the updated unit'}</Button></div>}
          {milestone.type === undefined && <p className="field-hint form-field-wide">This saved checkpoint still compares its best single recorded value. Choose another type to convert it; its old target will be cleared.</p>}
          <Button type="button" variant="destructive" size="small" onClick={() => onMilestonesChange(milestones.filter((item) => item.id !== milestone.id).map((item, position) => ({ ...item, position })))}>Remove milestone</Button>
        </div>
      </article>
    })}
  </section>
}

export function TrackerConfigurationEditor({ section, metrics, onMetricsChange, rule, onRuleChange, customFields, onCustomFieldsChange, milestones, onMilestonesChange, firstMetricTypeMode = 'setup', persistedMetricIds = [], metricsWithHistory = [], onRemoveMetric, planning, streakRuleMode = 'legacy', streakRule, onStreakRuleModeChange, onStreakRuleChange, milestoneContext }: Props) {
  const duplicateNameFor = (metric: TrackerMetricDefinition) => {
    const normalized = metric.name.trim().toLowerCase()
    if (!normalized) return ''
    const duplicate = metrics.find((item) => item.id !== metric.id && item.name.trim().toLowerCase() === normalized)
    return duplicate ? `This name duplicates “${duplicate.name}”. Rename one of these measures.` : ''
  }
  const incompatibleThresholdMessage = (metric: TrackerMetricDefinition, level: 'minimum' | 'target' | 'stretch') => {
    const value = metric.thresholds?.[level]
    if (value === undefined) return ''
    if (value < 0) return 'Target must be zero or greater.'
    if (metric.precision && Math.abs(value / metric.precision.increment - Math.round(value / metric.precision.increment)) > 1e-8) {
      return `This value is incompatible with increments of ${metric.precision.increment}. Enter a compatible value or change precision.`
    }
    return ''
  }
  const incompatiblePlanValues = (metric: TrackerMetricDefinition) => {
    if (!metric.precision || !planning) return []
    const amounts = [planning.dailyTargets[metric.id], planning.cumulativeTargets[metric.id], ...Object.values(planning.allocations?.[metric.id] ?? {}), ...Object.values(planning.manualAllocations?.[metric.id] ?? {})]
    return [...new Set(amounts.filter((value): value is number => value !== undefined && Math.abs(value / metric.precision!.increment - Math.round(value / metric.precision!.increment)) > 1e-8))]
  }
  function updateMetric(id: string, changes: Partial<TrackerMetricDefinition>) {
    onMetricsChange(metrics.map((metric) => metric.id === id ? { ...metric, ...changes } : metric))
  }

  function changeMetricType(metric: TrackerMetricDefinition, type: TrackerMetricDefinition['valueType']) {
    const apply = (changes: Partial<TrackerMetricDefinition>) => {
      const next = { ...metric, ...changes }
      updateMetric(metric.id, changes)
      onRuleChange(replaceRuleMetric(rule, metric.id, next))
      if (streakRuleMode === 'custom') onStreakRuleChange?.(replaceRuleMetric(streakRule, metric.id, next))
    }
    if (type === 'boolean') {
      apply({ valueType: type, unit: undefined, thresholds: undefined, precision: undefined, checklistItems: undefined })
    } else if (type === 'checklist') {
      apply({
        valueType: type, unit: undefined, precision: undefined,
        thresholds: { direction: 'increase', streakQualification: 'any-recorded-value' },
        checklistItems: metric.checklistItems?.length ? metric.checklistItems : [{ id: crypto.randomUUID(), label: 'Step 1', position: 0 }],
      })
    } else {
      apply({
        valueType: type,
        unit: metric.unit ?? '',
        thresholds: metric.thresholds ?? { direction: 'increase', streakQualification: 'any-recorded-value' },
        precision: metric.precision,
        checklistItems: undefined,
      })
    }
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
    if (ruleUsesMetric(rule, id) || ruleUsesMetric(streakRule, id) || milestones.some((milestone) => milestone.metricId === id)) return
    if (onRemoveMetric) { onRemoveMetric(id); return }
    const next = metrics.filter((metric) => metric.id !== id)
    onMetricsChange(next)
  }

  return (
    <div className="tracker-configuration">
      {(!section || section === 'metrics') && <section data-validation-path="metrics" className="configuration-section" aria-labelledby="metrics-heading">
        <SectionHeader title="Measures" headingId="metrics-heading" description="Use the same four value types for every measure." help={{ title: 'Measures and thresholds', summary: 'Measures are the values captured by each check-in; thresholds classify those values.', description: 'Yes/no stores completion, Quantity and Duration store numeric values, and Checklist stores checked items. Use separate measures for unlike quantities, such as pages and minutes. Minimum, target, and stretch describe one check-in only; they are separate from goal planning targets.' }} action={<Button type="button" variant="secondary" size="small" onClick={() => onMetricsChange([...metrics, freshMetric(metrics.length)])}>＋ Add measure</Button>} />
        {metrics.length === 0 && <p className="configuration-empty">Add at least one measure to record progress.</p>}
        {metrics.map((metric, index) => <article className="configuration-card" key={metric.id} aria-label={`${metric.name || `Measure ${index + 1}`} measure`}>
          {metrics.length > 1 && <header className="configuration-card-heading"><strong>{metric.name || `Measure ${index + 1}`}{metric.retiredAt ? ' · Retired' : ''}</strong><div><Button type="button" variant="destructive" size="small" disabled={Boolean(ruleUsesMetric(rule, metric.id) || ruleUsesMetric(streakRule, metric.id) || milestones.some((item) => item.metricId === metric.id) || metric.retiredAt)} title={ruleUsesMetric(rule, metric.id) || ruleUsesMetric(streakRule, metric.id) ? 'Resolve success and streak rule references first.' : milestones.some((item) => item.metricId === metric.id) ? 'Resolve milestone references first.' : undefined} onClick={() => removeMetric(metric.id)}>{persistedMetricIds.includes(metric.id) && metricsWithHistory.includes(metric.id) ? 'Retire measure' : 'Remove'}</Button>{(ruleUsesMetric(rule, metric.id) || ruleUsesMetric(streakRule, metric.id) || milestones.some((item) => item.metricId === metric.id)) && <small className="field-hint">Resolve linked rules or milestones first.</small>}</div></header>}
          <fieldset data-validation-path={`metrics.${index}`} disabled={Boolean(metric.retiredAt)} className={`form-grid configuration-grid${metric.retiredAt ? ' retired-measure-fields' : ''}`}>
            <label className="form-field"><span>Name <InfoButton title="Measure name" summary="Name the value you plan to record." description="Examples include problems solved, reading, or workout duration. The name appears in check-in forms, history, analytics, and goal plans." /></span><input disabled={metricsWithHistory.includes(metric.id)} data-validation-path={`metrics.${index}.name`} aria-label="Name" className="auth-input" maxLength={120} value={metric.name} onChange={(event) => updateMetric(metric.id, { name: event.target.value })} aria-invalid={Boolean(duplicateNameFor(metric))} aria-describedby={duplicateNameFor(metric) ? `metric-name-error-${metric.id}` : undefined} />{duplicateNameFor(metric) && <small id={`metric-name-error-${metric.id}`} className="auth-error">{duplicateNameFor(metric)}</small>}</label>
            <label className="form-field"><span>Value type <InfoButton title="Value type" summary="Choose the shape of each recorded value." description="Yes/no stores completion, Quantity and Duration store a number, and Checklist stores checked items. A measure with saved values keeps its type so those historical values retain their meaning; retire it and add a new measure to change how you track it." /></span>{index === 0 && firstMetricTypeMode === 'setup' ? <span className="measure-type-readonly"><span>{metric.valueType === 'boolean' ? 'Yes / no' : metric.valueType === 'quantity' ? 'Quantity' : metric.valueType === 'duration' ? 'Duration' : 'Checklist'}</span><small>Choose this type above.</small></span> : metricsWithHistory.includes(metric.id) ? <span className="measure-type-readonly"><span><AppIcon name="lock" />{metric.valueType === 'boolean' ? 'Yes / no' : metric.valueType === 'quantity' ? 'Quantity' : metric.valueType === 'duration' ? 'Duration' : 'Checklist'}</span><small>Saved values keep this type. Retire and add a measure to change it.</small></span> : <select aria-label={`Measure ${index + 1} value type`} className="auth-input" value={metric.valueType} onChange={(event) => changeMetricType(metric, event.target.value as TrackerMetricDefinition['valueType'])}><option value="boolean">Yes / no</option><option value="quantity">Quantity</option><option value="duration">Duration</option><option value="checklist">Checklist</option></select>}</label>
            {(metric.valueType === 'quantity' || metric.valueType === 'duration' || metric.valueType === 'checklist') && <>
              {metric.valueType !== 'checklist' && !(index === 0 && firstMetricTypeMode === 'setup') && <label className="form-field"><span>Unit <InfoButton title="Unit" summary="Add the unit used to interpret the number." description="Examples: pages, sessions, kilometers, minutes, or hours. Separate metrics are never combined across different units." /></span><input disabled={metricsWithHistory.includes(metric.id)} className="auth-input" value={metric.unit ?? ''} onChange={(event) => updateMetric(metric.id, { unit: event.target.value })} placeholder={metric.valueType === 'duration' ? 'minutes, hours' : 'pages, sessions'} /></label>}
              {metric.valueType !== 'checklist' && <>
                <label className="form-field"><span>How can this measure be recorded? <InfoButton title="Numeric precision" summary="Choose the smallest permitted amount for new check-ins and plan suggestions." description="Whole numbers suit problems or books. One decimal place suits half-hour sessions. Two decimal places suits distances or quarter-hour amounts. Previously saved values remain unchanged; this setting does not rewrite history." /></span><select data-validation-path={`metrics.${index}.precision.decimalPlaces`} className="auth-input" aria-label={`${metric.name} recording precision`} value={metric.precision ? String(metric.precision.decimalPlaces) : ''} onChange={(event) => {
                  const places = event.target.value === '' ? undefined : Number(event.target.value) as 0 | 1 | 2
                  // Start with the smallest step supported at this precision. A coarser
                  // default (0.5 or 0.25) can make existing thresholds and planning
                  // targets invalid even though the user only changed decimal places.
                  updateMetric(metric.id, { precision: places === undefined ? undefined : { decimalPlaces: places, increment: places === 0 ? 1 : places === 1 ? 0.1 : 0.01 } })
                }}><option value="">Keep existing precision</option><option value="0">Whole numbers</option><option value="1">One decimal place</option><option value="2">Up to two decimal places</option></select></label>
                {incompatiblePlanValues(metric).length > 0 && <p className="auth-error form-field-wide" role="alert">Saved plan values {incompatiblePlanValues(metric).join(', ')} for {metric.name} do not match increments of {metric.precision?.increment}. Change precision or update those values; they have not been rounded.</p>}
                {!isSchemaV4WriteEnabled() && <p className="field-hint form-field-wide" role="note">Precision changes are not writable in this production build yet. Apply and verify Supabase migration 20261012000100_tracker_numeric_precision_v4.sql, then build with VITE_ENABLE_TRACKER_SCHEMA_V4=true.</p>}
                {metric.precision && <label className="form-field"><span>Allowed increment <InfoButton title="Allowed increment" summary="Choose which values can be entered within the selected decimal precision." description="Decimal places set the maximum display precision; the increment sets allowed steps. For example, two decimal places with a 0.25 increment allows 0.25, 0.50, 0.75, and 1.00." /></span><select data-validation-path={`metrics.${index}.precision.increment`} className="auth-input" aria-label={`${metric.name} allowed increment`} value={metric.precision.increment} onChange={(event) => updateMetric(metric.id, { precision: metric.precision ? { ...metric.precision, increment: Number(event.target.value) } : undefined })}>{(metric.precision.decimalPlaces === 0 ? [1] : metric.precision.decimalPlaces === 1 ? [0.1, 0.5] : [0.01, 0.05, 0.1, 0.25, 0.5]).map((increment) => <option key={increment} value={increment}>{increment}</option>)}</select></label>}
              </>}
              {metric.valueType === 'checklist' ? <div className="field-hint">Checklist thresholds use the count of completed items. Higher is better.</div> : <label className="form-field"><span>Threshold direction <InfoButton title="Threshold direction" summary="Choose whether a larger or smaller value represents progress." description="Higher is better suits totals like pages or steps. Lower is better suits measures like minutes spent or errors, where reducing the value is the aim. This direction affects threshold qualification and trend interpretation." /></span><select disabled={metricsWithHistory.includes(metric.id)} className="auth-input" value={metric.thresholds?.direction ?? 'increase'} onChange={(event) => updateThreshold(metric, 'direction', event.target.value)}><option value="increase">Higher is better</option><option value="decrease">Lower is better</option></select></label>}
              {(['minimum', 'target', 'stretch'] as const).map((level) => { const issue = incompatibleThresholdMessage(metric, level); const errorId = `metric-${metric.id}-${level}-error`; return <label className="form-field" key={level}><span>{level[0]?.toUpperCase()}{level.slice(1)} threshold <em>optional</em> <InfoButton title={`${level[0]?.toUpperCase()}${level.slice(1)} threshold`} summary={`Set the ${level} for a single check-in.`} description={`Thresholds classify one recorded value. Minimum is a baseline, target is the intended result, and stretch is an ambitious result; none is the whole deadline total. Example: for 5 problems a day, set target 5 and stretch 8.`} /></span><input disabled={metricsWithHistory.includes(metric.id)} data-validation-path={`metrics.${index}.thresholds.${level}`} className="auth-input" type="number" min="0" step={metric.precision?.increment ?? 'any'} value={metric.thresholds?.[level] ?? ''} onChange={(event) => updateThreshold(metric, level, event.target.value)} aria-invalid={Boolean(issue)} aria-describedby={issue ? errorId : undefined} />{issue && <small id={errorId} className="auth-error">{issue}</small>}</label>})}
              {streakRuleMode === 'legacy' && <label className="form-field"><span>Streak qualifies at <InfoButton title="Streak qualification" summary="Choose the minimum result that keeps this legacy tracker’s streak going." description="This saved per-measure setting is retained for trackers using their original streak behavior. A check-in can be Completed without qualifying for a streak, or qualify for a streak without meeting the Success Rule. New explicit Streak Rules are configured separately below the Success Rule. Standard Mode counts scheduled opportunities; Strict Mode requires qualifying activity on every active date." /></span><select className="auth-input" value={metric.thresholds?.streakQualification ?? 'any-recorded-value'} onChange={(event) => updateThreshold(metric, 'streakQualification', event.target.value)}><option value="any-recorded-value">Any recorded value</option>{metric.thresholds?.minimum !== undefined && <option value="minimum">Minimum</option>}{metric.thresholds?.target !== undefined && <option value="target">Target</option>}</select></label>}
            </>}
              {metric.valueType === 'checklist' && <div data-validation-path={`metrics.${index}.checklistItems`} className="form-field form-field-wide checklist-editor"><span><InfoButton title="Checklist items" summary="Define the items you can check off during a check-in." description="A checklist entry stores each item’s checked state. Thresholds and planning targets use the number of checked items. Daily checklist targets cannot exceed the number of defined items; cumulative goals may count incremental completed items across entries." />Checklist items</span>{(metric.checklistItems ?? []).map((item, itemIndex) => <div className="inline-editor-row" key={item.id}><input data-validation-path={`metrics.${index}.checklistItems.${itemIndex}.label`} aria-label={`Checklist item ${itemIndex + 1}`} className="auth-input" value={item.label} onChange={(event) => updateMetric(metric.id, { checklistItems: metric.checklistItems?.map((candidate) => candidate.id === item.id ? { ...candidate, label: event.target.value } : candidate) })} /><Button type="button" variant="destructive" size="small" onClick={() => updateMetric(metric.id, { checklistItems: metric.checklistItems?.filter((candidate) => candidate.id !== item.id).map((candidate, position) => ({ ...candidate, position })) })}>Remove</Button></div>)}<Button type="button" variant="secondary" size="small" onClick={() => updateMetric(metric.id, { checklistItems: [...(metric.checklistItems ?? []), { id: crypto.randomUUID(), label: '', position: metric.checklistItems?.length ?? 0 }] })}>＋ Add checklist item</Button></div>}
          </fieldset>
          {metricsWithHistory.includes(metric.id) && !metric.retiredAt && <small className="field-hint">Saved check-ins use this measure’s current name, unit, and meaning. These settings are locked; retire it and add a new measure to change tracking.</small>}
        </article>)}
      </section>}

      {(!section || section === 'rules') && <section data-validation-path="qualificationRule" className="configuration-section" aria-label={section === 'rules' ? 'Success rule' : undefined} aria-labelledby={section === 'rules' ? undefined : 'rule-heading'}>
        <SectionHeader title={section === 'rules' ? undefined : 'Success rule'} headingId={section === 'rules' ? undefined : 'rule-heading'} description="Define what makes a check-in successful." help={{ title: 'Success rule', summary: 'Define what makes a check-in qualify as a success.', description: 'A rule can compare a measure to a value or achievement threshold. Combine conditions using AND (all), OR (any), or At least N. Success qualification drives success rates and daily success XP. Streak qualification has its own setting.' }} action={rule ? <Button type="button" variant="quiet" size="small" onClick={() => onRuleChange(undefined)}>Clear rule</Button> : metrics.length > 0 ? <Button type="button" variant="secondary" size="small" onClick={() => onRuleChange(defaultRule(metrics[0]!))}>＋ Add success rule</Button> : undefined} />
        {rule && metrics.length > 0 && <><RuleNode rule={rule} metrics={metrics} path={[]} onChange={(_, changed) => onRuleChange(changed)} ruleName="Success" pathRoot="qualificationRule" /><p className="field-hint rule-readable-summary" aria-live="polite">Success summary: {ruleSummary(rule, metrics)}</p></>}
      </section>}

      {(!section || section === 'streak-rules') && <section data-validation-path="streakRule" className="configuration-section" aria-label={section === 'streak-rules' ? 'Streak rule' : undefined} aria-labelledby={section === 'streak-rules' ? undefined : 'streak-rule-heading'}>
        <SectionHeader title={section === 'streak-rules' ? undefined : 'Streak rule'} headingId={section === 'streak-rules' ? undefined : 'streak-rule-heading'} description="Choose which recorded progress keeps this tracker’s streak going." help={{ title: 'Streak rule', summary: 'Streak rules are evaluated separately from success rules.', description: 'A Streak Rule decides whether a scheduled date advances the tracker streak. It does not mark that date successful or award daily success XP. In Standard Mode, holidays and rest days pause the streak; Strict Mode keeps its existing every-active-date policy.' }} />
        {onStreakRuleModeChange && <label className="form-field"><span>Streak rule mode</span><select data-validation-path="streakRuleMode" aria-label="Streak rule mode" className="auth-input" value={streakRuleMode} onChange={(event) => onStreakRuleModeChange(event.target.value as TrackerStreakRuleMode | 'legacy')}>
          {streakRuleMode === 'legacy' && <option value="legacy">Keep existing streak behavior</option>}
          <option value="same-as-success">Same as Success Rule</option><option value="custom">Custom Streak Rule</option>
        </select></label>}
        {streakRuleMode === 'legacy' && <p className="field-hint">This saved tracker keeps its existing streak behavior until you choose a new rule.</p>}
        {streakRuleMode === 'same-as-success' && <p className="field-hint rule-readable-summary">Streak summary: follows Success Rule changes{rule ? ` · ${ruleSummary(rule, metrics)}` : ' · the existing implicit success condition'}.</p>}
        {streakRuleMode === 'custom' && <>
          <p className="field-hint">This rule stays independent when the Success Rule changes.</p>
          {streakRule && metrics.length > 0 ? <><RuleNode rule={streakRule} metrics={metrics} path={[]} onChange={(_, changed) => onStreakRuleChange?.(changed)} ruleName="Streak" pathRoot="streakRule" /><p className="field-hint rule-readable-summary" aria-live="polite">Streak summary: {ruleSummary(streakRule, metrics)}</p></>
            : metrics.length > 0 && <Button type="button" variant="secondary" size="small" onClick={() => onStreakRuleChange?.(rule ?? defaultRule(metrics[0]!))}>＋ Add streak rule</Button>}
        </>}
      </section>}

      {(!section || section === 'fields') && <section data-validation-path="customFields" className="configuration-section" aria-labelledby="custom-fields-heading">
        <SectionHeader title="Custom fields" headingId="custom-fields-heading" description="Optional details to capture alongside a future check-in." help={{ title: 'Custom fields', summary: 'Capture context alongside a check-in without turning it into a progress metric.', description: 'Custom fields can be text, numeric details, dates, selections, and other input types. They appear in future check-in forms. They do not automatically affect goal totals, thresholds, streaks, or success rules.' }} action={<Button type="button" variant="secondary" size="small" onClick={() => onCustomFieldsChange([...customFields, { id: crypto.randomUUID(), name: '', type: 'text', required: false, position: customFields.length }])}>＋ Add field</Button>} />
        {customFields.map((field, index) => <article className="configuration-card" key={field.id}><div className="form-grid configuration-grid">
          <label className="form-field"><span>Field name <InfoButton title="Custom field name" summary="Label the extra detail you want to record." description="This name appears on the check-in form and in saved history. Use a prompt such as “Where did I practice?” or “How was my energy?”" /></span><input data-validation-path={`customFields.${index}.name`} aria-label="Field name" className="auth-input" value={field.name} onChange={(event) => onCustomFieldsChange(customFields.map((item) => item.id === field.id ? { ...item, name: event.target.value } : item))} /></label>
          <label className="form-field"><span>Field type <InfoButton title="Custom field type" summary="Choose how an optional check-in detail should be entered." description="Text, number, date, time, duration, selection, rating, and other types affect the input shown when you record a check-in. Custom fields are descriptive details and do not act as progress metrics or goal totals." /></span><select data-validation-path={`customFields.${index}.type`} aria-label="Field type" className="auth-input" value={field.type} onChange={(event) => onCustomFieldsChange(customFields.map((item) => item.id === field.id ? { ...item, type: event.target.value as CustomFieldDefinition['type'], options: ['single-select', 'multi-select'].includes(event.target.value) ? item.options ?? ['Option 1'] : undefined } : item))}>{['text', 'long-text', 'integer', 'decimal', 'boolean', 'date', 'time', 'duration', 'single-select', 'multi-select', 'url', 'rating', 'quantity'].map((type) => <option key={type} value={type}>{type.replaceAll('-', ' ')}</option>)}</select></label>
          {['duration', 'quantity'].includes(field.type) && <label className="form-field"><span>Unit <em>optional</em> <InfoButton title="Custom field unit" summary="Name the unit for a custom numeric detail." description="This unit labels that detail in the form and history. It does not combine with tracker metrics or affect goal calculations." /></span><input className="auth-input" value={field.unit ?? ''} onChange={(event) => onCustomFieldsChange(customFields.map((item) => item.id === field.id ? { ...item, unit: event.target.value } : item))} /></label>}
          {(['single-select', 'multi-select'].includes(field.type)) && <label className="form-field form-field-wide"><span>Options <em>one per line</em> <InfoButton title="Selection options" summary="Provide the choices available for this custom field." description="Enter one option per line. Single-select allows one choice; multi-select allows several. Existing historical values are not rewritten when you edit these options." /></span><textarea data-validation-path={`customFields.${index}.options`} className="auth-input tracker-textarea" value={(field.options ?? []).join('\n')} onChange={(event) => onCustomFieldsChange(customFields.map((item) => item.id === field.id ? { ...item, options: event.target.value.split('\n').map((option) => option.trim()).filter(Boolean) } : item))} /></label>}
          <label className="form-check"><input type="checkbox" checked={field.required} onChange={(event) => onCustomFieldsChange(customFields.map((item) => item.id === field.id ? { ...item, required: event.target.checked } : item))} />Required <InfoButton title="Required custom field" summary="Require a value before saving a new check-in." description="When enabled, the check-in form asks for this detail each time. This does not change old check-ins or goal qualification unless a separate success rule uses a metric." /></label>
              <Button type="button" variant="destructive" size="small" onClick={() => onCustomFieldsChange(customFields.filter((item) => item.id !== field.id).map((item, position) => ({ ...item, position })))}>Remove field</Button>
        </div></article>)}
      </section>}

      {(!section || section === 'milestones') && <MilestoneEditor metrics={metrics} milestones={milestones} onMilestonesChange={onMilestonesChange} context={milestoneContext ?? { kind: 'goal', metrics, schedule: { kind: 'every-day' }, strictMode: false, scheduling: { mode: 'ongoing' }, deadline: undefined }} section={section === 'milestones' ? 'milestones' : undefined} />}
    </div>
  )
}
