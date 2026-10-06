type PlaceholderPageProps = { title: string }

export function PlaceholderPage({ title }: PlaceholderPageProps) {
  return (
    <section className="placeholder-page">
      <div className="eyebrow"><span className="eyebrow-line" /> YOUR SPACE</div>
      <h1>{title}<span className="title-period">.</span></h1>
      <p>This space is taking shape. Your progress will appear here as you build your routine.</p>
      <div className="placeholder-rule" />
      <span className="placeholder-label">COMING INTO FOCUS</span>
    </section>
  )
}
