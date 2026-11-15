// Main application entry point with professional scientific UI and navigation
import { lazy, Suspense, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore, type ViewId } from './lib/store';
import type { StringKey } from './lib/i18n';
import { AlertCenter, JudgeTour, SettingsPanel, Toasts } from './components/Overlays';
import { PetCompanion } from './components/PetCompanion';
import { nf, riskColor, ordinal } from './lib/format';
import { provenanceMix, REGIONS } from './lib/data';
import { initSound, isSoundEnabled, setSoundEnabled, playClick, playAlertChime } from './lib/sound';

// Lazy-loaded pages
const Watch = lazy(() => import('./pages/Watch').then(m => ({ default: m.Watch })));
const Atlas = lazy(() => import('./pages/Atlas').then(m => ({ default: m.Atlas })));
const Diagnosis = lazy(() => import('./pages/Diagnosis').then(m => ({ default: m.Diagnosis })));
const Outlook = lazy(() => import('./pages/Outlook').then(m => ({ default: m.Outlook })));
const Brief = lazy(() => import('./pages/Brief').then(m => ({ default: m.Brief })));
const Method = lazy(() => import('./pages/Method').then(m => ({ default: m.Method })));
const Community = lazy(() => import('./pages/Community').then(m => ({ default: m.Community })));
const Developers = lazy(() => import('./pages/Developers').then(m => ({ default: m.Developers })));

const BOOT_TITLES: Record<ViewId, string> = {
  watch: 'Assembling the orbital watch',
  atlas: 'Opening the burning atlas',
  diagnosis: 'Reading the bias X-ray',
  outlook: 'Building the four‑week outlook',
  brief: 'Setting the field brief',
  method: 'Laying out the method',
  community: 'Opening the community hub',
  developers: 'Opening the developer portal',
};

function WatchBoot() {
  return (
    <div className="watch watch-boot" role="status" aria-live="polite">
      <div className="watch-boot-card">
        <span className="boot-mark" aria-hidden>◈</span>
        <strong>{BOOT_TITLES.watch}</strong>
        <p>Loading the globe, the live FIRMS window and the satellite tracks it calibrates to.</p>
        <span className="boot-line" aria-hidden />
      </div>
    </div>
  );
}

function PageBoot({ view }: { view: Exclude<ViewId, 'watch'> }) {
  return (
    <section className="boot-page page-boot" role="status" aria-live="polite">
      <span className="boot-mark" aria-hidden>◈</span>
      <strong>{BOOT_TITLES[view]}</strong>
      <span className="boot-line" aria-hidden />
    </section>
  );
}

const NAV: { id: ViewId; label: string; short: string }[] = [
  { id: 'watch', label: 'Orbital Watch', short: 'Watch' },
  { id: 'atlas', label: 'Atlas', short: 'Atlas' },
  { id: 'diagnosis', label: 'Diagnosis', short: 'Diagnose' },
  { id: 'outlook', label: 'Outlook', short: 'Outlook' },
  { id: 'brief', label: 'Brief', short: 'Brief' },
  { id: 'method', label: 'Method', short: 'Method' },
  { id: 'community', label: 'Community Hub', short: 'Hub' },
  { id: 'developers', label: 'Developers', short: 'Dev' },
];

function TopNav({ drawerOpen, setDrawerOpen }: { drawerOpen: boolean; setDrawerOpen: (v: boolean) => void }) {
  const store = useStore();
  const high = store.alerts.filter(a => a.status.percentile >= 85).length;
  const [soundOn, setSoundOn] = useState(() => isSoundEnabled());
  return (
    <header className="topnav">
      <button type="button" className="nav-hamburger" onClick={() => setDrawerOpen(true)} aria-label="Open main navigation">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
      </button>
      <button type="button" className="brand" onClick={() => store.setView('watch')} aria-label="Continuum home">
        <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.4" />
            <path d="M12 3a9 9 0 0 1 9 9" stroke="#ff8a3d" strokeWidth="2.5" />
            <circle cx="12" cy="12" r="3" fill="#ff8a3d" stroke="none" />
          </svg>
        </span>
        <span className="brand-text"><strong>CONTINUUM</strong><small>{store.t('tagline')}</small></span>
      </button>
      <nav className="nav" aria-label="Primary">
        {NAV.map(n => {
          const label = store.t(`nav_${n.id}` as StringKey);
          return (
            <button
              key={n.id}
              type="button"
              className={store.view === n.id ? 'active' : ''}
              aria-current={store.view === n.id ? 'page' : undefined}
              onClick={() => store.setView(n.id)}
              title={label}
            >
              <span className="nav-full">{label}</span>
              <span className="nav-short">{n.short}</span>
            </button>
          );
        })}
      </nav>
      <div className="nav-right">
        <span className={`nav-live ${store.live ? 'on' : ''}`} title={`NASA FIRMS live window — real‑time through ${store.today}`}>
          <i /> <span>{store.live ? 'LIVE' : 'SYNC'}</span>
        </span>
        <button type="button" className="nav-alert" onClick={() => store.setAlertsOpen(true)} aria-label={`Open alert center, ${high} areas above the 85th percentile`}>
          <span className="alert-bell" aria-hidden>◉</span>
          <span className="nav-label">{store.t('alerts')}</span>
          {high > 0 && <span className="alert-count">{high}</span>}
        </button>
        <button
          type="button"
          className="icon-btn nav-sound"
          onClick={() => {
            const next = !soundOn;
            setSoundOn(next);
            setSoundEnabled(next);
            if (next) playClick();
          }}
          aria-label={soundOn ? 'Disable audio feedback' : 'Enable audio feedback'}
          title={soundOn ? 'Audio telemetry ON' : 'Audio telemetry OFF'}
        >
          <span aria-hidden>{soundOn ? '🔊' : '🔇'}</span>
        </button>
        <button type="button" className="lang-btn" onClick={() => store.setSettings({ lang: store.settings.lang === 'en' ? 'es' : 'en' })} aria-label="Toggle language">
          {store.settings.lang.toUpperCase()}
        </button>
        <button type="button" className="icon-btn nav-settings" onClick={() => store.setSettingsOpen(true)} aria-label="Settings">
          <span aria-hidden>⚙</span>
        </button>
      </div>
    </header>
  );
}

function ActiveRegionBar() {
  const store = useStore();
  const [pickerOpen, setPickerOpen] = useState(false);
  const r = store.region;
  const status = store.status;

  return (
    <aside className="context-bar" aria-label="Selected region context">
      <div className="context-bar-inner">
        <div className="context-target">
          <span className="context-label">ACTIVE AREA</span>
          <strong className="context-name">{r.name}</strong>
          <span className="context-meta">{r.country} · {r.biome} · {nf(r.areaKm2)} km²</span>
        </div>
        <div className="context-status">
          <span className="context-band-pill" style={{ borderColor: riskColor(status.band), color: riskColor(status.band) }}>
            <span className="dot" style={{ background: riskColor(status.band) }} />
            {status.band.toUpperCase()} · {ordinal(Math.round(status.percentile))} PERCENTILE
          </span>
          <button
            type="button"
            className="context-switch-btn"
            onClick={() => setPickerOpen(!pickerOpen)}
            aria-expanded={pickerOpen}
          >
            <span>Change area</span> <span aria-hidden>{pickerOpen ? '▲' : '▼'}</span>
          </button>
        </div>
      </div>
      {pickerOpen && (
        <div className="context-picker">
          <div className="context-picker-head">
            <span>Select Pilot Region or Switch Area</span>
            <button type="button" className="context-picker-close" onClick={() => setPickerOpen(false)} aria-label="Close selector">✕</button>
          </div>
          <div className="context-picker-chips">
            {REGIONS.map((reg) => (
              <button
                key={reg.id}
                type="button"
                className={`context-chip ${reg.id === store.regionId ? 'active' : ''}`}
                onClick={() => {
                  store.selectRegion(reg.id);
                  setPickerOpen(false);
                }}
              >
                <strong>{reg.shortName}</strong>
                <small>{reg.country} · {reg.biome}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function Footer() {
  const store = useStore();
  const mix = provenanceMix(store.records);
  return (
    <footer className="footer">
      <div className="footer-top">
        <div className="footer-brand">
          <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.4" />
            <path d="M12 3a9 9 0 0 1 9 9" stroke="#ff8a3d" strokeWidth="2.5" />
            <circle cx="12" cy="12" r="3" fill="#ff8a3d" stroke="none" />
          </svg>
        </span>
          <div>
            <strong>CONTINUUM</strong>
            <span>One continuous record of burning, from Terra to VIIRS.</span>
          </div>
        </div>
        <div className="footer-links">
          <button type="button" onClick={() => store.setView('watch')}>Orbital Watch</button>
          <button type="button" onClick={() => store.setView('atlas')}>Atlas</button>
          <button type="button" onClick={() => store.setView('diagnosis')}>Diagnosis</button>
          <button type="button" onClick={() => store.setView('outlook')}>Outlook</button>
          <button type="button" onClick={() => store.setView('brief')}>Brief</button>
          <button type="button" onClick={() => store.setView('method')}>Method</button>
          <button type="button" onClick={() => store.setView('community')}>Community Hub</button>
          <button type="button" onClick={() => store.setView('developers')}>Developers</button>
          <button type="button" onClick={() => store.setTourOpen(true)} style={{ color: 'var(--accent)' }}>About & Tour</button>
          <a
            href="https://discord.gg/XYHzfcrPDK"
            target="_blank"
            rel="noopener noreferrer"
            className="footer-social-link"
            aria-label="Join our Discord server"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', color: '#5865F2', fontWeight: 600, textDecoration: 'none' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
            </svg>
            <span>Join our Discord</span>
          </a>
        </div>
        <div className="footer-meta">
          <span>Live detections worldwide: {nf(store.live?.meta.counts.kept ?? 0)}</span>
          <span>Data through {store.today}</span>
          <span>Method v0.1.0</span>
        </div>
      </div>
      <div className="footer-bottom">
        <p>
          Supports situational awareness and research. Not an official warning, dispatch, or evacuation service. {mix.archived > 0 ? `${nf(mix.archived)} of ${nf(mix.days)} record days are NASA FIRMS archive detections; the rest is a calibrated reconstruction. The live window and orbital positions are real.` : 'The long record is a calibrated reconstruction; the live window and orbital positions are real.'}
        </p>
        <p>Built for the 2026 NASA Space Apps Challenge. NASA FIRMS · NASA POWER · NASA GIBS · CelesTrak · Natural Earth.</p>
      </div>
    </footer>
  );
}

function DataLoadState({ onRetry }: { onRetry: () => void }) {
  const store = useStore();
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="boot-page" role="status" aria-live="polite">
      <div className="boot-panel">
        {store.loadError ? (
          <div className="boot-error-card">
            <span className="boot-status-badge">ERROR</span>
            <h2>Telemetry service unavailable</h2>
            <p>{store.loadError}</p>
            <div className="boot-actions">
              <button type="button" className="btn btn-primary" onClick={onRetry}>
                Retry connection
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => store.setSettingsOpen(true)}>
                Open settings
              </button>
            </div>
            <p className="boot-note">
              The application shell remains available. Offline estimates and static references can still be accessed.
            </p>
          </div>
        ) : (
          <div className="boot-loading-card">
            <div className="boot-spinner-wrap">
              <div className="boot-spinner" />
            </div>
            <h2>Acquiring live FIRMS orbital window</h2>
            <p className="boot-lead">
              Loading the bundled satellite record. Network requests time out after 10 seconds.
            </p>
            <p className="boot-sub">
              Continuum synchronizes 26 years of MODIS/VIIRS historical calibration with today&apos;s FIRMS near-real-time overpasses (~3 h latency).
            </p>
            <div className="boot-progress-track">
              <div
                className="boot-progress-fill"
                style={{ width: `${Math.min(95, Math.max(10, seconds * 3))}%` }}
              />
            </div>
            <div className="boot-timer">
              <span>Time elapsed: {seconds}s</span>
              <span>Host status: {seconds > 8 ? 'Waking free-tier container…' : 'Connecting to API…'}</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export function App() {
  const store = useStore();
  const view = store.view;
  const [drawerOpen, setDrawerOpen] = useState(false);
  return (
    <div className={`app view-${view}`}>
      <a className="skip-link" href="#main" onClick={e => { e.preventDefault(); const main = document.getElementById('main'); main?.focus(); main?.scrollIntoView({ block: 'start' }); }}>Skip to content</a>
      <TopNav drawerOpen={drawerOpen} setDrawerOpen={setDrawerOpen} />
      {view !== 'watch' && store.live && <ActiveRegionBar />}
      <div className={`nav-drawer-overlay ${drawerOpen ? 'open' : ''}`} onClick={() => setDrawerOpen(false)} />
      <nav className={`nav-drawer ${drawerOpen ? 'open' : ''}`} aria-label="Primary navigation">
        <div className="nav-drawer-head">
          <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.4" />
            <path d="M12 3a9 9 0 0 1 9 9" stroke="#ff8a3d" strokeWidth="2.5" />
            <circle cx="12" cy="12" r="3" fill="#ff8a3d" stroke="none" />
          </svg>
        </span>
          <strong>CONTINUUM</strong>
          <button type="button" className="icon-btn nav-close" onClick={() => setDrawerOpen(false)} aria-label="Close navigation">
            <span aria-hidden>✕</span>
          </button>
        </div>
        <nav>
          {NAV.map(n => {
            const label = store.t(`nav_${n.id}` as StringKey);
            return (
              <button
                key={n.id}
                type="button"
                className={store.view === n.id ? 'active' : ''}
                aria-current={store.view === n.id ? 'page' : undefined}
                onClick={() => { store.setView(n.id); setDrawerOpen(false); }}
                title={label}
              >
                {label}
              </button>
            );
          })}
        </nav>
        <div className="nav-drawer-actions">
          <button type="button" className="btn btn-small btn-primary" onClick={() => { store.setView('watch'); setDrawerOpen(false); }}>Orbital Watch</button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => { store.setView('atlas'); setDrawerOpen(false); }}>Atlas</button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => { store.setView('diagnosis'); setDrawerOpen(false); }}>Diagnosis</button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => { store.setView('outlook'); setDrawerOpen(false); }}>Outlook</button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => { store.setView('brief'); setDrawerOpen(false); }}>Brief</button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => { store.setView('method'); setDrawerOpen(false); }}>Method</button>
          <button type="button" className="link-btn" onClick={() => { store.setTourOpen(true); setDrawerOpen(false); }}>About & Judge Tour</button>
          <button type="button" className="link-btn" onClick={() => { store.setSettingsOpen(true); setDrawerOpen(false); }}>Settings</button>
          <a
            href="https://discord.gg/XYHzfcrPDK"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-small btn-ghost"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', color: '#5865F2', textDecoration: 'none', marginTop: '0.5rem' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
            </svg>
            <span>Join our Discord</span>
          </a>
        </div>
      </nav>
      <main id="main" tabIndex={-1} className={view === 'watch' ? 'main main-watch' : 'main'}>
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
          >
            {!store.live && store.loading ? (
              <DataLoadState onRetry={store.retryLoad} />
            ) : (!store.live ? (
              <DataLoadState onRetry={store.retryLoad} />
            ) : (
              <Suspense fallback={view === 'watch' ? <WatchBoot /> : <PageBoot view={view} />}>
                {view === 'watch' && <Watch />}
                {view === 'atlas' && <Atlas />}
                {view === 'diagnosis' && <Diagnosis />}
                {view === 'outlook' && <Outlook />}
                {view === 'brief' && <Brief />}
                {view === 'method' && <Method />}
                {view === 'community' && <Community />}
                {view === 'developers' && <Developers />}
              </Suspense>
            ))}
          </motion.div>
        </AnimatePresence>
      </main>
      {view !== 'watch' && store.live && <Footer />}
      <AlertCenter />
      <SettingsPanel />
      <JudgeTour />
      <Toasts />
      <PetCompanion />
    </div>
  );
}
