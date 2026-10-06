export function TodayPage() {
  return (
    <section className="welcome-panel" aria-labelledby="welcome-title">
      <div className="eyebrow"><span className="eyebrow-line" /> YOUR NEXT CHAPTER STARTS HERE</div>
      <div className="welcome-copy">
        <h1 id="welcome-title">Make today<br /><span>count.</span></h1>
        <p>A little progress, repeated often, adds up to something remarkable.</p>
      </div>
      <div className="welcome-art" aria-hidden="true">
        <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
        <div className="art-sun" /><div className="art-spark spark-one">✳</div><div className="art-spark spark-two">✦</div>
        <div className="art-caption">ONE DAY<br />AT A TIME</div>
      </div>
      <div className="welcome-footer">
        <div className="welcome-note"><span className="note-mark">✦</span><span><strong>Your space is ready.</strong><small>Your daily check-in will live right here.</small></span></div>
        <span className="local-badge"><span className="sync-dot" /> SAVED ON THIS DEVICE</span>
      </div>
    </section>
  )
}
