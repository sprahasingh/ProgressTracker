import type { TrackerDefinition, TrackerEntry } from '../../domain/trackers/types'
import { evaluateMilestones } from '../../domain/trackers/milestones'
import { calendarDateLabel } from '../shared/localDates'

export function MilestoneProgressList({ tracker, entries, asOfDate, holidays, timeZone }: {
  tracker: TrackerDefinition
  entries: readonly TrackerEntry[]
  asOfDate: string
  holidays?: ReadonlySet<string>
  timeZone?: string
}) {
  const milestones = evaluateMilestones({ tracker, entries, asOfDate, holidays, timeZone })
  if (!milestones.length) return null
  const definitions = new Map(tracker.milestones.map((milestone) => [milestone.id, milestone]))
  return <section className="milestone-progress-list" aria-label={`${tracker.name} milestone progress`}>
    <ul>
      {milestones.map((milestone) => {
        const definition = definitions.get(milestone.milestoneId)
        return <li className={`milestone-progress-card${milestone.completed ? ' is-complete' : ''}${milestone.configurationIssue ? ' has-configuration-issue' : ''}`} key={milestone.milestoneId}>
          <div className="milestone-progress-heading"><div><strong>{milestone.title}</strong><small>{milestone.trackingLabel}</small>{milestone.type === 'legacy' && <small className="milestone-progress-label">{milestone.progressLabel}</small>}</div>{milestone.completed && <span className="milestone-complete-badge">Completed</span>}</div>
          {definition?.description && <p className="milestone-user-description">{definition.description}</p>}
          <p className="milestone-preview-text">{milestone.preview}</p>
          {milestone.type !== 'legacy' && <strong className="milestone-progress-label">{milestone.progressLabel}</strong>}
          {milestone.percent !== null && <div className="milestone-progress-meter" role="progressbar" aria-label={`${milestone.title}: ${milestone.progressLabel}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(milestone.percent)}><span style={{ width: `${milestone.percent}%` }} /></div>}
          {milestone.secondaryLabel && milestone.secondaryValue !== undefined && <small className="milestone-secondary-progress">{milestone.secondaryLabel}: {milestone.secondaryValue} days</small>}
          {milestone.reachedDate && <small className="milestone-reached-date">Target reached {calendarDateLabel(milestone.reachedDate, { month: 'short', day: 'numeric', year: 'numeric' })}</small>}
          {!milestone.completed && definition?.dueDate && <small className="milestone-due-date">Due {calendarDateLabel(definition.dueDate)}</small>}
          {milestone.configurationIssue && <small className="milestone-issue" role="status">{milestone.configurationIssue}</small>}
        </li>
      })}
    </ul>
  </section>
}
