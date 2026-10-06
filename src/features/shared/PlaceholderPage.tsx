import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'

type PlaceholderPageProps = { title: string }

export function PlaceholderPage({ title }: PlaceholderPageProps) {
  return (
    <section className="placeholder-page" aria-labelledby={`page-${title.toLowerCase()}`}>
      <PageHeader
        headingId={`page-${title.toLowerCase()}`}
        eyebrow="YOUR SPACE"
        title={title}
        description="A considered view of your consistency and progress over time."
      />
      <div className="placeholder-rule" />
      <EmptyState
        title={`${title} is taking shape`}
        description="This space will fill with your own progress as you build your routine."
      />
    </section>
  )
}
