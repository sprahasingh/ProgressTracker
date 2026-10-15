import React from 'react'
import { createRoot } from 'react-dom/client'
import '../src/styles.css'
import { InfoButton } from '../src/components/ui/InfoButton'
import { XpInformation } from '../src/features/dashboard/ProgressionAchievementsPage'

const overview = {
  confirmedXp: 30,
  officialLevel: { level: 1, currentLevelXp: 0, nextLevelXp: 100, progressXp: 30, requiredXp: 100 },
}

function Fixture() {
  return <>
    <main style={{ minHeight: '1800px', padding: '36px 20px' }}>
      <p>Background page content</p>
      <section className="progression-overview-grid" aria-label="Experience card layout fixture">
        <section className="progression-level-card-shell">
          <div className="progression-xp-header"><strong>Your Experience</strong><div><span className="progression-level-pill">LEVEL 1</span><button className="info-button" aria-label="Card info fixture">i</button></div></div>
          <button type="button" className="progression-level-card"><strong className="progression-xp-total">30 <small>XP</small></strong><span className="progression-level-track"><span style={{ width: '30%' }} /></span><span className="progression-level-caption">70 XP to Level 2</span></button>
        </section>
      </section>
      <div style={{ marginTop: '250px' }}>
        <InfoButton title="How XP and levels work" label="XP and level information" compact content={<XpInformation overview={overview} />} />
      </div>
      <div style={{ marginTop: '900px' }}>Background end</div>
    </main>
    <nav className="mobile-nav" aria-label="Bottom navigation">
      <span className="mobile-nav-link">Today</span><span className="mobile-nav-link">Wins</span>
    </nav>
  </>
}

window.__xpTouchEvents = []
for (const type of ['touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointermove', 'pointerup']) {
  window.addEventListener(type, (event) => {
    const target = event.target instanceof Element ? event.target : null
    window.__xpTouchEvents.push({
      type,
      target: target?.closest('.info-popover-content') ? '.info-popover-content' : target?.className?.toString() ?? target?.tagName ?? 'unknown',
      defaultPrevented: event.defaultPrevented,
    })
  }, { passive: true })
}

createRoot(document.getElementById('root')).render(<Fixture />)
