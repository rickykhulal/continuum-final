// Developer Portal — multi-language API examples for the Continuum public API.
import { useCallback, useState } from 'react';
import { useStore } from '../lib/store';
import { PageHeader } from './Community';
import { API_BASE, generateApiKey } from '../lib/api';

const BASE_URL = new URL(API_BASE, window.location.origin).href.replace(/\/$/, '');

const snippets: Record<string, string> = {
  javascript: `// Web (JavaScript / Fetch)
fetch('${BASE_URL}/live-fires?region_id=country-kenya', {
  headers: { 'x-api-key': 'YOUR_API_KEY' }
})
  .then((r) => r.json())
  .then((data) => console.log(data))
  .catch((err) => console.error(err));`,

  python: `# Python (Requests)
import requests

url = '${BASE_URL}/live-fires'
params = {'region_id': 'country-kenya'}
headers = {'x-api-key': 'YOUR_API_KEY'}
resp = requests.get(url, params=params, headers=headers)
resp.raise_for_status()
print(resp.json())`,

  curl: `# cURL
curl -G '${BASE_URL}/live-fires' \\
  -d 'region_id=country-kenya' \\
  -H 'x-api-key: YOUR_API_KEY'`,

  csharp: `// C# (HttpClient)
using System;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Tasks;

var client = new HttpClient();
client.DefaultRequestHeaders.Add("x-api-key", "YOUR_API_KEY");
var url = "${BASE_URL}/live-fires?region_id=country-kenya";
var data = await client.GetFromJsonAsync<JsonElement>(url);
Console.WriteLine(data);`,

  php: `<?php
// PHP (cURL)
$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, '${BASE_URL}/live-fires?region_id=country-kenya');
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, ['x-api-key: YOUR_API_KEY']);
$response = curl_exec($ch);
curl_close($ch);
echo $response;`,

  cpp: `// C++ (libcurl)
#include <curl/curl.h>
#include <iostream>
#include <string>

static size_t WriteCb(void* ptr, size_t size, size_t nmemb, std::string* s) {
  s->append((char*)ptr, size * nmemb);
  return size * nmemb;
}

int main() {
  CURL* curl = curl_easy_init();
  if (!curl) return 1;
  std::string url = "${BASE_URL}/live-fires?region_id=country-kenya";
  std::string readBuffer;
  struct curl_slist* headers = curl_slist_append(nullptr, "x-api-key: YOUR_API_KEY");
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCb);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &readBuffer);
  CURLcode res = curl_easy_perform(curl);
  curl_slist_free_all(headers);
  if (res != CURLE_OK) {
    std::cerr << curl_easy_strerror(res) << std::endl;
    return 1;
  }
  std::cout << readBuffer << std::endl;
  curl_easy_cleanup(curl);
  return 0;
}`,
};

const LANGUAGES = [
  { id: 'javascript', label: 'JavaScript (Fetch)' },
  { id: 'python', label: 'Python (Requests)' },
  { id: 'curl', label: 'cURL' },
  { id: 'csharp', label: 'C# (HttpClient)' },
  { id: 'php', label: 'PHP (cURL)' },
  { id: 'cpp', label: 'C++ (libcurl)' },
];

const endpoints = [
  { method: 'GET', path: '/health', desc: 'Liveness check — returns ok status.' },
  { method: 'GET', path: '/atlas', desc: 'Processed burning calendar — dates, raw/harmonized counts, 90% CI.' },
  { method: 'GET', path: '/diagnosis', desc: 'Bias X-ray — sensor overlap ratio k, 2012 break, calibration metrics.' },
  { method: 'GET', path: '/outlook?region_id=nepal', desc: 'Selected-region analog seasons, four-week departure and backtest results. Use a pilot ID or country-<id>.' },
  { method: 'GET', path: '/brief', desc: 'Generated textual/markdown brief for a region.' },
  { method: 'GET', path: '/trend', desc: 'Harmonized historical data for a given area.' },
  { method: 'GET', path: '/live-fires', desc: 'Live fire detections for a region or area.' },
  { method: 'GET', path: '/community/feed', desc: 'Community posts and verified announcements.' },
  { method: 'POST', path: '/community/vote', desc: 'Send { postId, action: "verify" } to confirm an incident (three distinct voting keys); send { postId, optionIndex } to vote in a poll. Requires X-API-Key.' },
];

export function Developers() {
  const store = useStore();
  const [activeLang, setActiveLang] = useState('javascript');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const t = (key: string) => store.t(key as never);

  const generateKey = useCallback(async () => {
    setGenerating(true);
    setKeyError(null);
    try {
      setApiKey(await generateApiKey());
      setCopied(false);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Could not generate API key.');
    } finally {
      setGenerating(false);
    }
  }, []);

  return (
    <section className="page developers-page" aria-label="Developer Portal">
      <PageHeader
        eyebrow="Developer Portal"
        title="Continuum Public API"
        intro={
          <>
            Build with harmonized satellite data. The public API serves sensor-harmonized
            burning activity for pilot regions, country borders, and any circle or polygon
            area on Earth.{' '}
            <a href="/openapi.json" className="feed-link" target="_blank" rel="noreferrer">
              OpenAPI spec
            </a>
          </>
        }
        actions={
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => store.setView('watch')}
            >
              ← Orbital Watch
            </button>
          </>
        }
      />

      <div className="dev-base">
        <span className="dev-base-label">Base URL</span>
        <code className="dev-base-url">{BASE_URL}</code>
      </div>

      <section className="dev-api-key">
        <h2 className="dev-section-title">API Key</h2>
        <p className="dev-key-note">
          Data routes use an <span className="mono">x-api-key</span> header once keys are registered.
          Health, the OpenAPI spec and key generation remain public.
          Generate a key below, then pass it on every request. Keys are shown once and never logged.
        </p>
        <div className="dev-key-card">
          {apiKey ? (
            <>
              <span className="dev-key-label">Your key</span>
              <div className="dev-key-value-wrapper">
                <code className="dev-key-value">{apiKey}</code>
                <button
                  type="button"
                  className="btn btn-small btn-ghost dev-key-copy"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(apiKey);
                      setKeyError(null);
                      setCopied(true);
                    } catch {
                      setCopied(false);
                      setKeyError('Clipboard unavailable. Select and copy the key manually.');
                    }
                  }}
                  title="Copy key"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              {copied && <span role="status">Key copied.</span>}
              {keyError && <span role="alert" className="dev-key-error">{keyError}</span>}
            </>
          ) : (
            <>
              <span className="dev-key-label">No key generated yet</span>
              <button
                type="button"
                className="btn btn-primary"
                disabled={generating}
                onClick={generateKey}
              >
                {generating ? 'Generating…' : 'Generate API key'}
              </button>
              {keyError && <span className="dev-key-error">{keyError}</span>}
            </>
          )}
        </div>
      </section>

      <section className="dev-endpoints">
        <h2 className="dev-section-title">Endpoints</h2>
        <p className="dev-key-note">
          Build a full clone of Continuum. These endpoints expose our processed, harmonized data — no NASA API keys
          or raw CSV downloading required. Data routes use an
          <span className="mono">x-api-key</span> header.
        </p>
        <table className="dev-table">
          <thead>
            <tr>
              <th>Method</th>
              <th>Endpoint</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((ep) => (
              <tr key={ep.path}>
                <td>
                  <span className={`dev-method ${ep.method.toLowerCase()}`}>{ep.method}</span>
                </td>
                <td><code>{ep.path}</code></td>
                <td>{ep.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="dev-snippets">
        <h2 className="dev-section-title">Code Snippets — GET /api/v1/live-fires</h2>
        <div className="dev-tabs">
          {LANGUAGES.map((lang) => (
            <button
              key={lang.id}
              type="button"
              className={`dev-tab ${activeLang === lang.id ? 'active' : ''}`}
              onClick={() => setActiveLang(lang.id)}
            >
              {lang.label}
            </button>
          ))}
        </div>
        <pre className="dev-code"><code>{snippets[activeLang]}</code></pre>
      </section>
    </section>
  );
}
