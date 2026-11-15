import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { apiFetch } from '../lib/api';
import { nf } from '../lib/format';
import { searchReportLocations, type ReportLocation } from '../lib/geocoding';

type PostType = 'text' | 'poll' | 'anomaly';
// Shared with the Developer Portal.
export function PageHeader({ eyebrow, title, intro, actions }: { eyebrow?: string; title: string; intro?: ReactNode; actions?: ReactNode }) {
  return <header className="page-head community-page-head">
    {eyebrow && <span className="page-eyebrow">{eyebrow}</span>}
    <h1 className="page-title">{title}</h1>
    {intro && <div className="page-intro">{intro}</div>}
    {actions && <div className="page-actions">{actions}</div>}
  </header>;
}
type Post = {
  id: string; author: string; type: PostType; content: string; createdAt: string;
  source: 'web' | 'discord'; locationName: string; lat: number | null; lon: number | null;
  verificationStatus: 'pending' | 'satellite_confirmed' | 'weather_warning' | 'community_verified';
  weatherData: { temp: number; humidity: number; wind: number } | null;
  weatherObservedAt?: string | null; verificationVotes: number; hasVerificationVote: boolean;
  satelliteMatch: { distanceKm: number; acquiredAt: string } | null;
  pollOptions: { text: string; votes: number }[]; selectedOption: number | null;
  imageBase64?: string;
  imageUrl?: string;
};

async function apiJson(path: string, init?: RequestInit) {
  const response = await apiFetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || `Community service unavailable (HTTP ${response.status}).`);
  return body;
}

export function Community() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState({ author: '', type: 'anomaly' as PostType, content: '' });
  const [pollOptions, setPollOptions] = useState(['', '']);
  const [filter, setFilter] = useState<'all' | 'anomaly' | 'poll'>('all');
  const [submitting, setSubmitting] = useState(false);
  const [voting, setVoting] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [location, setLocation] = useState<ReportLocation | null>(null);
  const [results, setResults] = useState<ReportLocation[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searched, setSearched] = useState(false);
  const [activeResult, setActiveResult] = useState(0);
  const [manual, setManual] = useState({ lat: '', lon: '', name: '' });
  const [imageBase64, setImageBase64] = useState('');
  const [readingImage, setReadingImage] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const imageReader = useRef<FileReader | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const loadVersion = useRef(0);
  const submittingRef = useRef(false);
  const votingRef = useRef(false);

  const load = useCallback(async (background = false) => {
    if (background && (submittingRef.current || votingRef.current)) return;
    const version = ++loadVersion.current;
    if (!background) setLoading(true);
    try {
      const data = await apiJson('/community/feed');
      if (version !== loadVersion.current) return;
      setPosts(data.posts ?? []); setFeedError(null);
    } catch (error) {
      if (version === loadVersion.current) setFeedError(error instanceof Error ? error.message : 'Could not load the feed.');
    } finally { if (version === loadVersion.current) setLoading(false); }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === 'visible') void load(true); };
    const timer = window.setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => { loadVersion.current++; clearInterval(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); };
  }, [load]);
  useEffect(() => () => { imageReader.current?.abort(); imageReader.current = null; }, []);

  const clearImage = () => {
    imageReader.current?.abort(); imageReader.current = null; setImageBase64(''); setReadingImage(false);
    if (imageInput.current) imageInput.current.value = '';
  };
  const chooseImage = (file?: File) => {
    imageReader.current?.abort(); imageReader.current = null; setImageBase64(''); setReadingImage(false); setFormError(null);
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024 || !file.size) {
      clearImage(); setFormError('Choose a PNG, JPEG or WebP image of at most 4 MiB.'); return;
    }
    const reader = new FileReader(); imageReader.current = reader; setReadingImage(true);
    reader.onload = async () => {
      try {
        if (typeof reader.result !== 'string') throw new Error('Invalid image.');
        const preview = new Image(); preview.src = reader.result; await preview.decode();
        if (preview.naturalWidth * preview.naturalHeight > 24000000) throw new Error('Image too large.');
        if (imageReader.current === reader) setImageBase64(reader.result);
      } catch { if (imageReader.current === reader) { clearImage(); setFormError('Could not read this image. Use a valid image up to 24 megapixels.'); } }
      finally { if (imageReader.current === reader) setReadingImage(false); }
    };
    reader.onerror = () => { if (imageReader.current === reader) { clearImage(); setFormError('Could not read the image. Please select it again.'); } };
    reader.readAsDataURL(file);
  };
  useEffect(() => {
    if (location || query.trim().length < 2) { setSearching(false); return; }
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchReportLocations(query, controller.signal).then(matches => {
        if (!controller.signal.aborted) { setResults(matches); setActiveResult(0); setSearched(true); }
      }).catch(error => {
        if (!controller.signal.aborted) { setSearchError(error instanceof Error ? error.message : 'Location search unavailable.'); setSearched(true); }
      }).finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, location]);

  const changeQuery = (value: string) => {
    setQuery(value); setLocation(null); setResults([]); setSearchError(''); setSearched(false);
    setManual({ lat: '', lon: '', name: '' });
  };
  const chooseLocation = (value: ReportLocation) => {
    setLocation(value); setQuery(value.locationName); setResults([]); setSearchError(''); setSearching(false);
    setManual({ lat: '', lon: '', name: '' }); searchInput.current?.focus();
  };
  const changeManual = (field: keyof typeof manual, value: string) => {
    setManual(old => ({ ...old, [field]: value })); setLocation(null); setQuery(''); setResults([]); setSearchError(''); setSearched(false);
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current || readingImage) return;
    setFormError(null); setNotice('');
    submittingRef.current = true; setSubmitting(true);
    try {
      let point = location;
      if (manual.lat.trim() || manual.lon.trim() || manual.name.trim()) {
        const lat = Number(manual.lat), lon = Number(manual.lon);
        if (!manual.lat.trim() || !manual.lon.trim() || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          throw new Error('Enter both valid coordinates: latitude −90 to 90, longitude −180 to 180.');
        }
        point = { locationName: manual.name.trim(), lat, lon };
      } else if (query.trim() && !point) throw new Error('Select a location from the results, or clear the search.');
      if (draft.type === 'poll' && (pollOptions.some(option => !option.trim()) || new Set(pollOptions.map(o => o.trim().toLowerCase())).size !== pollOptions.length)) {
        throw new Error('Enter at least two different poll options.');
      }
      const result = await apiJson('/community/posts', { method: 'POST', body: JSON.stringify({ ...draft, imageBase64,
        ...(point ?? {}), pollOptions: draft.type === 'poll' ? pollOptions.map(text => ({ text })) : undefined,
      }) });
      ++loadVersion.current; // An older feed response must not erase a freshly saved post.
      setLoading(false); setPosts(current => [result.post, ...current.filter(p => p.id !== result.post.id)]);
      setDraft(old => ({ ...old, content: '', type: 'anomaly' })); setPollOptions(['', '']);
      clearImage(); setFeedError(null);
      changeQuery(''); setFilter('all');
      setNotice(result.discordDelivery === 'failed' ? 'Post saved. Discord delivery failed; your report remains in the feed.' : 'Post published.');
    } catch (error) { setFormError(error instanceof Error ? error.message : 'Could not publish the post.'); }
    finally { submittingRef.current = false; setSubmitting(false); }
  };

  const vote = async (postId: string, optionIndex?: number) => {
    if (votingRef.current) return;
    votingRef.current = true; setVoting(postId); setFeedError(null);
    try {
      const result = await apiJson('/community/vote', { method: 'POST', body: JSON.stringify(optionIndex == null ? { postId, action: 'verify' } : { postId, optionIndex }) });
      ++loadVersion.current; setLoading(false);
      setPosts(current => current.map(post => post.id === postId ? result.post : post));
      setNotice(optionIndex == null ? 'Community confirmation saved.' : 'Vote saved. You can change your choice.');
    } catch (error) { setFeedError(error instanceof Error ? error.message : 'Could not save your vote.'); }
    finally { votingRef.current = false; setVoting(null); }
  };
  const visible = posts.filter(post => filter === 'all' || post.type === filter);

  return <section className="page community-page" aria-label="Community Hub">
    <header className="community-hero"><span className="eyebrow">Community Hub</span><h1>Notes from the ground.</h1>
      <p>Share what you see. Add a location. Connect field reports with satellite evidence.</p>
      <div className="community-guide"><span>15 km satellite cross-check</span><span>Web + Discord reports</span></div>
    </header>
    <form className="compose-box" onSubmit={create} aria-label="Create a community post">
      <div className="community-compose-head"><div className="community-avatar" aria-hidden="true">{draft.author.trim().charAt(0).toUpperCase() || '+'}</div><h2>Share an update</h2></div>
      <fieldset disabled={submitting} className="compose-inner">
        <legend className="sr-only">Post details</legend>
        <div className="compose-row">
          <label className="field"><span>Your name <small>(optional)</small></span><input aria-label="Author name" className="compose-input" maxLength={60} value={draft.author} onChange={e => setDraft({ ...draft, author: e.target.value })} placeholder="Anonymous" /></label>
          <label className="field"><span>Post type</span><select aria-label="Post type" className="compose-select" value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value as PostType })}><option value="anomaly">Anomaly report</option><option value="text">Field note</option><option value="poll">Poll</option></select></label>
        </div>
        <textarea aria-label="Post content" className="compose-text" required maxLength={1000} rows={4} value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })} placeholder={draft.type === 'poll' ? 'What would you like to ask the community?' : 'Describe the smoke, fire activity, or unusual conditions you observed…'} />
        <div className="community-image-upload">
          <label className="field"><span>Attach an image <small>(optional · PNG, JPEG, WebP · up to 4 MiB)</small></span>
            <input ref={imageInput} type="file" accept="image/*" aria-label="Attach report image" onChange={e => chooseImage(e.target.files?.[0])} />
          </label>
          {readingImage && <span role="status">Reading image…</span>}
          {imageBase64 && <div className="community-image-preview"><img src={imageBase64} alt="Selected report attachment preview" /><button type="button" className="btn btn-ghost btn-small" onClick={clearImage}>Remove image</button></div>}
        </div>
        {draft.type === 'poll' && <div className="community-poll-options">{pollOptions.map((option, i) => <label className="field" key={i}><span>Option {i + 1}</span><input aria-label={`Poll option ${i + 1}`} className="compose-input" required maxLength={100} value={option} onChange={e => setPollOptions(old => old.map((text, j) => j === i ? e.target.value : text))} /></label>)}</div>}
        <div className="community-location-search">
          <label className="field"><span>Report location <small>(optional)</small></span>
            <input ref={searchInput} className="compose-input" aria-label="Search report location" role="combobox" aria-autocomplete="list" aria-expanded={results.length > 0} aria-controls="community-location-results" aria-activedescendant={results.length ? `community-location-${activeResult}` : undefined}
              autoComplete="off" maxLength={160} value={query} placeholder="Search a city or place, e.g. Biratnagar" onChange={e => changeQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { setResults([]); return; }
                if (!results.length) return;
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActiveResult(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length); }
                if (e.key === 'Enter') { e.preventDefault(); chooseLocation(results[activeResult]); }
              }} />
          </label>
          {results.length > 0 && <ul id="community-location-results" role="listbox" aria-label="Matching locations" className="community-location-results">{results.map((result, i) => <li key={`${result.lat}:${result.lon}:${i}`} id={`community-location-${i}`} role="option" aria-selected={activeResult === i}>
            <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => chooseLocation(result)}><strong>{result.locationName}</strong><span>{nf(result.lat, 4)}, {nf(result.lon, 4)}</span></button>
          </li>)}</ul>}
          <div role="status" className="community-search-status">{searching ? 'Searching Open-Meteo…' : searchError || (searched && !location && !results.length ? 'No matching places. Try another name or enter coordinates.' : '')}</div>
          {location && <div className="community-selected-location"><span>{location.locationName} · {nf(location.lat, 4)}, {nf(location.lon, 4)}</span><button type="button" className="btn btn-ghost btn-small" onClick={() => changeQuery('')}>Clear location</button></div>}
        </div>
        <details className="community-manual"><summary>Enter coordinates manually</summary><div className="compose-row">
          <label className="field"><span>Latitude</span><input aria-label="Report latitude" className="compose-input" inputMode="decimal" value={manual.lat} onChange={e => changeManual('lat', e.target.value)} placeholder="−90 to 90" /></label>
          <label className="field"><span>Longitude</span><input aria-label="Report longitude" className="compose-input" inputMode="decimal" value={manual.lon} onChange={e => changeManual('lon', e.target.value)} placeholder="−180 to 180" /></label>
        </div><label className="field"><span>Location name <small>(optional)</small></span><input aria-label="Manual location name" className="compose-input" maxLength={160} value={manual.name} onChange={e => changeManual('name', e.target.value)} /></label></details>
        {formError && <p className="community-error" role="alert">{formError}</p>}
        <div className="compose-controls"><span className="community-character-count">{draft.content.length} / 1,000</span><button type="submit" className="btn btn-primary compose-submit" disabled={!draft.content.trim() || submitting || readingImage}>{submitting ? 'Publishing…' : 'Publish post'}</button></div>
      </fieldset>
    </form>
    <p className="community-evidence-note">“Satellite Confirmed” means a stored FIRMS detection lies within 15 km. “High Risk Weather” describes hot, dry and windy conditions, not proof of fire. “Community Verified” means three community confirmations. Each source of evidence is shown separately.</p>
    <div className="community-notice" role="status">{notice}</div>
    <div className="community-feed-head"><h2>Community feed</h2><button type="button" className="btn btn-ghost btn-small" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh feed'}</button></div>
    <div className="community-filters" role="group" aria-label="Filter community feed">{(['all', 'anomaly', 'poll'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All updates' : value === 'anomaly' ? 'Anomalies' : 'Polls'}</button>)}</div>
    {feedError && <p className="community-error" role="alert">{feedError}</p>}
    <div className="feed" aria-busy={loading}>
      {!loading && !visible.length && <div className="community-empty"><strong>{posts.length ? 'No posts in this category.' : 'Start the conversation.'}</strong><p>Share a field observation or ask the community a question.</p></div>}
      {visible.map(post => {
        const confirmed = post.verificationStatus === 'satellite_confirmed';
        const badge = {
          satellite_confirmed: { className: 'confirmed', text: '✅ Satellite Confirmed' },
          weather_warning: { className: 'weather-warning', text: '🔥 High Risk Weather' },
          community_verified: { className: 'community-verified', text: '✅ Community Verified' },
          pending: { className: 'pending', text: '⚠️ Pending Verification' },
        }[post.verificationStatus];
        const total = post.pollOptions.reduce((sum, option) => sum + option.votes, 0);
        return <article key={post.id} className={`feed-card ${post.type}`} data-post-id={post.id}>
          <div className="card-head"><div className="community-avatar" aria-hidden="true">{post.author.charAt(0).toUpperCase()}</div><div className="community-post-byline"><strong className="card-author">{post.author}</strong><time dateTime={post.createdAt}>{new Date(post.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div><span className={`community-source ${post.source}`}>{post.source === 'discord' ? '🤖 Discord' : 'Web'}</span></div>
          <p className="card-content">{post.content}</p>
          {post.weatherData && <div className="community-weather"><span>🌡️ {nf(post.weatherData.temp, 1)}°C</span><span>💧 {nf(post.weatherData.humidity, 0)}% RH</span><span>💨 {nf(post.weatherData.wind, 1)} km/h</span>
            {post.weatherObservedAt && <small>Open-Meteo current estimate · {post.weatherObservedAt.slice(0, 16).replace('T', ' ')} UTC</small>}
          </div>}
          {post.imageBase64 && <img className="community-post-image" src={post.imageBase64} alt={`Report attachment from ${post.author}`} loading="lazy" />}
          {!post.imageBase64 && post.imageUrl?.startsWith('https://') && <a className="community-image-link" href={post.imageUrl} target="_blank" rel="noopener noreferrer">View attached image ↗</a>}
          {(post.locationName || (post.lat != null && post.lon != null)) && <div className="community-post-location"><strong>{post.locationName || 'Reported coordinates'}</strong><span>{post.lat != null && post.lon != null ? `${nf(post.lat, 4)}, ${nf(post.lon, 4)}` : 'Coordinates unavailable'}</span></div>}
          <div className="community-post-status"><span className={`community-verification ${badge.className}`} title={post.verificationStatus === 'weather_warning' ? 'No satellite signature, but extreme fire weather detected.' : undefined}>{badge.text}</span><span className="community-post-type">{post.type === 'anomaly' ? 'Anomaly report' : post.type === 'poll' ? 'Community poll' : 'Field note'}</span></div>
          {post.verificationStatus === 'weather_warning' && <p className="community-match">No satellite signature, but extreme fire weather detected.</p>}
          {confirmed && post.satelliteMatch && <p className="community-match">Nearby FIRMS detection · {nf(post.satelliteMatch.distanceKm, 1)} km · {post.satelliteMatch.acquiredAt.slice(0, 10)} UTC</p>}
          {post.type === 'anomaly' && !confirmed && <div className="community-confirmations"><span>{post.verificationVotes ?? 0} / 3 community confirmations</span>
            {post.verificationStatus !== 'community_verified' && <button type="button" className="btn btn-ghost btn-small" disabled={post.hasVerificationVote || voting === post.id} onClick={() => void vote(post.id)}>{post.hasVerificationVote ? 'You confirmed this report' : 'I can confirm this report'}</button>}
          </div>}
          {post.type === 'poll' && <div className="poll">{post.pollOptions.map((option, i) => <button type="button" className={`poll-btn ${post.selectedOption === i ? 'voted' : ''}`} key={i} aria-pressed={post.selectedOption === i} disabled={voting === post.id} onClick={() => void vote(post.id, i)}><span>{option.text}</span><span className="poll-count">{option.votes} {option.votes === 1 ? 'vote' : 'votes'}{total ? ` · ${Math.round(option.votes / total * 100)}%` : ''}</span></button>)}<span className="poll-total">{total} {total === 1 ? 'vote' : 'votes'} · informal community poll</span></div>}
        </article>;
      })}
    </div>
  </section>;
}
