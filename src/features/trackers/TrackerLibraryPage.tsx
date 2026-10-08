import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import type { StoredTrackerDefinition } from '../../db/models'

const kindLabels = { habit: 'Habit', goal: 'Goal', challenge: 'Challenge', project: 'Project' }

export function TrackerLibraryPage() {
  const [trackers, setTrackers] = useState<StoredTrackerDefinition[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setTrackers(await localRepository.listTrackers(showArchived))
    } catch {
      setError('Your trackers could not be loaded from this device.')
    } finally {
      setLoading(false)
    }
  }, [showArchived])

  useEffect(() => { void refresh() }, [refresh])

  async function archive(id: string) {
    try {
      await localRepository.archiveTracker(id)
      await refresh()
    } catch {
      setError('This tracker could not be archived. Your saved data is unchanged.')
    }
  }

  return (
    <section className="tracker-page" aria-labelledby="trackers-title">
      <PageHeader
        headingId="trackers-title"
        eyebrow="YOUR PRACTICE"
        title="Trackers"
        description="Habits, goals, challenges, and projects you choose to make progress on."
        action={<Link className="button button-primary button-medium" to="/trackers/new">＋ Create tracker</Link>}
      />
      <div className="tracker-library-toolbar">
        <p>{showArchived ? 'Showing active and archived trackers' : 'Showing active trackers'}</p>
        <Button variant="quiet" size="small" onClick={() => setShowArchived((value) => !value)}>{showArchived ? 'Hide archived' : 'Show archived'}</Button>
      </div>
      {error && <div role="alert" className="form-alert">{error}</div>}
      {loading ? <p role="status" className="tracker-loading">Loading your trackers…</p> : trackers.length === 0 ? (
        <Surface>
          <EmptyState title={showArchived ? 'No trackers yet' : 'A blank page is a good start'} description="Create a tracker with a schedule and a measure that feels useful to you. Your data stays on this device." action={<Link className="button button-primary button-medium" to="/trackers/new">Create your first tracker</Link>} />
        </Surface>
      ) : (
        <div className="tracker-card-grid">
          {trackers.map((tracker) => (
            <Surface key={tracker.id} className="tracker-card">
              <div className="tracker-card-top"><span className="tracker-kind-chip">{kindLabels[tracker.kind]}</span>{tracker.status === 'archived' && <span className="tracker-archived-chip">Archived</span>}</div>
              <h2>{tracker.name}</h2>
              <p className="tracker-card-description">{tracker.description || 'No description yet.'}</p>
              <div className="tracker-card-meta">
                <span>{tracker.schedule.kind === 'every-day' ? 'Every day' : tracker.schedule.kind === 'weekdays' ? 'Weekdays' : tracker.schedule.kind === 'times-per-week' ? `${tracker.schedule.count} times a week` : 'Flexible schedule'}</span>
                {tracker.deadline && <span>Due {tracker.deadline}</span>}
              </div>
              <div className="tracker-card-actions">
                <Link className="button button-secondary button-small" to={`/trackers/${encodeURIComponent(tracker.id)}/edit`}>Edit setup</Link>
                {tracker.status !== 'archived' && <Button variant="quiet" size="small" onClick={() => void archive(tracker.id)}>Archive</Button>}
              </div>
            </Surface>
          ))}
        </div>
      )}
    </section>
  )
}
