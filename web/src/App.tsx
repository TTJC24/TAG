import { useEffect, useState } from 'react';

const FALLBACK_SOURCES = [
  'm365-calendar',
  'm365-mail',
  'm365-sharepoint',
  'm365-teams',
  'acumatica',
  'pipedrive',
];

const SOURCE_LABELS: Record<string, string> = {
  'm365-calendar': 'Calendar',
  'm365-mail': 'Email',
  'm365-sharepoint': 'SharePoint',
  'm365-teams': 'Teams',
  acumatica: 'Acumatica',
  pipedrive: 'Pipedrive',
};

function formatSource(id: string): string {
  if (SOURCE_LABELS[id]) return SOURCE_LABELS[id];
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join(' ');
}

interface ConnectorStatusBrief {
  id: string;
  displayName?: string;
  liveReady?: boolean;
  fixtureAvailable?: boolean;
  documentCount?: number;
}

const TOKEN = (import.meta as ImportMeta & { env: Record<string, string> }).env
  .VITE_API_TOKEN ?? 'dev-local-token';

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network/CORS failure (e.g. API not running).
    const msg = err instanceof Error ? err.message : String(err);
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      throw new Error(
        'Cannot reach the API. — Is `bun run api` running on port 4317?',
      );
    }
    throw err instanceof Error ? err : new Error(msg);
  }
  if (!res.ok) {
    const txt = await res.text();
    let parsed: { error?: unknown; hint?: unknown } | null = null;
    try {
      parsed = txt ? (JSON.parse(txt) as { error?: unknown; hint?: unknown }) : null;
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed.error === 'string' && parsed.error.length > 0) {
      const hint = typeof parsed.hint === 'string' && parsed.hint.length > 0 ? parsed.hint : null;
      throw new Error(hint ? `${parsed.error} — ${hint}` : parsed.error);
    }
    throw new Error(`${res.status} ${res.statusText || 'Error'}`);
  }
  return (await res.json()) as T;
}

async function apiGet<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      throw new Error(
        'Cannot reach the API. — Is `bun run api` running on port 4317?',
      );
    }
    throw err instanceof Error ? err : new Error(msg);
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText || 'Error'}`);
  }
  return (await res.json()) as T;
}

function ErrorDisplay({ message }: { message: string }) {
  const idx = message.indexOf(' — ');
  if (idx === -1) return <div className="error">{message}</div>;
  return (
    <div className="error">
      {message.slice(0, idx)}
      <div className="hint">{message.slice(idx + 3)}</div>
    </div>
  );
}

interface SearchHit {
  slug: string;
  title?: string;
  source_id?: string;
  chunk_text?: string;
  score?: number;
}

interface AskAnswer {
  text: string;
  citations: Array<{ slug: string; source_id: string; title: string | null; source_uri: string | null }>;
}

function SourceChips({
  value,
  onChange,
  sources,
  connectors,
}: {
  value: Set<string>;
  onChange: (s: Set<string>) => void;
  sources: string[];
  connectors: Record<string, ConnectorStatusBrief>;
}) {
  return (
    <div className="sources" role="group" aria-label="Filter by source">
      {sources.map((s) => {
        const on = value.has(s);
        const status = connectors[s];
        const title = status
          ? `${status.displayName ?? formatSource(s)}${
              typeof status.documentCount === 'number' ? ` · ${status.documentCount} docs` : ''
            }${status.liveReady ? ' · live' : status.fixtureAvailable ? ' · fixture' : ''}`
          : formatSource(s);
        return (
          <button
            key={s}
            type="button"
            className={`chip ${on ? 'on' : ''}`}
            title={title}
            aria-pressed={on}
            onClick={() => {
              const next = new Set(value);
              if (on) next.delete(s);
              else next.add(s);
              onChange(next);
            }}
          >
            {formatSource(s)}
          </button>
        );
      })}
    </div>
  );
}

function Search({
  availableSources,
  connectors,
}: {
  availableSources: string[];
  connectors: Record<string, ConnectorStatusBrief>;
}) {
  const [query, setQuery] = useState('');
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiPost<{ hits: SearchHit[] }>('/search', {
        query,
        sources: Array.from(sources),
        limit: 15,
      });
      setHits(data.hits);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label htmlFor="q-search" className="sr-only">
          Search query
        </label>
        <input
          id="q-search"
          className="input"
          placeholder="Search the company brain..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="button" type="submit" disabled={loading}>
          {loading ? 'Searching...' : 'Search'}
        </button>
      </form>
      <SourceChips
        value={sources}
        onChange={setSources}
        sources={availableSources}
        connectors={connectors}
      />
      {error && <ErrorDisplay message={error} />}
      {loading && (
        <div className="skeleton" aria-live="polite" aria-busy="true">
          Searching the index...
        </div>
      )}
      {!loading && hits === null && !error && (
        <div className="empty">
          Try <em>"vendor onboarding"</em> or pick a source above. Examples:{' '}
          <em>"Acme pump terms"</em>, <em>"last week's calendar"</em>.
        </div>
      )}
      {hits && hits.length === 0 && <div>No results.</div>}
      {hits?.map((h, i) => (
        <div key={`${h.slug}-${i}`} className="result">
          <h3>{h.title || h.slug}</h3>
          <div className="meta">
            {h.source_id ? `${formatSource(h.source_id)} · ` : ''}
            {h.slug}
            {typeof h.score === 'number' ? ` · score ${h.score.toFixed(3)}` : ''}
          </div>
          {h.chunk_text && (
            <div className="snippet">{h.chunk_text.slice(0, 400)}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function formatAnswerForCopy(answer: AskAnswer): string {
  const lines = [answer.text.trimEnd()];
  if (answer.citations.length > 0) {
    lines.push('', 'Sources:');
    for (const c of answer.citations) {
      const label = `[${formatSource(c.source_id)}] ${c.title ?? c.slug}`;
      lines.push(c.source_uri ? `- ${label} (${c.source_uri})` : `- ${label}`);
    }
  }
  return lines.join('\n');
}

function Ask({
  availableSources,
  connectors,
}: {
  availableSources: string[];
  connectors: Record<string, ConnectorStatusBrief>;
}) {
  const [question, setQuestion] = useState('');
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!answer) return;
    try {
      await navigator.clipboard.writeText(formatAnswerForCopy(answer));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard may be unavailable (e.g. insecure context)
    }
  }

  async function run() {
    if (!question.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiPost<AskAnswer>('/ask', {
        question,
        sources: Array.from(sources),
      });
      setAnswer(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label htmlFor="q-ask" className="sr-only">
          Question
        </label>
        <input
          id="q-ask"
          className="input"
          placeholder="Ask a question..."
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button className="button" type="submit" disabled={loading}>
          {loading ? 'Asking...' : 'Ask'}
        </button>
      </form>
      <SourceChips
        value={sources}
        onChange={setSources}
        sources={availableSources}
        connectors={connectors}
      />
      {error && <ErrorDisplay message={error} />}
      {loading && (
        <div className="skeleton" aria-live="polite" aria-busy="true">
          Thinking... this can take 10-30 seconds on a cold cache.
        </div>
      )}
      {!loading && answer === null && !error && (
        <div className="empty">
          Ask a natural-language question grounded in your sources. Cold queries
          can take 10-30 seconds; subsequent asks are faster. Examples:{' '}
          <em>"What did we agree with Acme on payment terms?"</em>,{' '}
          <em>"Summarize this week's customer calls."</em>
        </div>
      )}
      {answer && (
        <>
          <div className="answer-toolbar">
            <button type="button" className="link-button" onClick={() => void handleCopy()}>
              {copied ? 'Copied' : 'Copy answer'}
            </button>
          </div>
          <div className="answer">{answer.text}</div>
          {answer.citations.length > 0 && (
            <div>
              <strong>Citations</strong>
              <ul>
                {answer.citations.map((c) => {
                  const label = `[${formatSource(c.source_id)}] ${c.title ?? c.slug}`;
                  return (
                    <li key={c.slug} className="citation">
                      {c.source_uri ? (
                        <a href={c.source_uri} target="_blank" rel="noopener noreferrer">
                          {label}
                        </a>
                      ) : (
                        <span>{label}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<'search' | 'ask'>('search');
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  const [healthChecking, setHealthChecking] = useState(false);
  const [availableSources, setAvailableSources] = useState<string[]>(FALLBACK_SOURCES);
  const [connectors, setConnectors] = useState<Record<string, ConnectorStatusBrief>>({});

  async function checkHealth() {
    setHealthChecking(true);
    try {
      const r = await fetch('/api/health');
      setApiOk(r.ok);
    } catch {
      setApiOk(false);
    } finally {
      setHealthChecking(false);
    }
  }

  useEffect(() => {
    void checkHealth();
  }, []);
  useEffect(() => {
    apiGet<{ sources: string[]; connectors: ConnectorStatusBrief[] }>('/sources')
      .then((data) => {
        if (Array.isArray(data.sources) && data.sources.length > 0) {
          setAvailableSources(data.sources);
        }
        if (Array.isArray(data.connectors)) {
          const map: Record<string, ConnectorStatusBrief> = {};
          for (const c of data.connectors) {
            if (c && typeof c.id === 'string') map[c.id] = c;
          }
          setConnectors(map);
        }
      })
      .catch((err) => {
        console.warn('Failed to load /sources; using fallback list', err);
      });
  }, []);
  return (
    <div className="container">
      <h1>company-brain</h1>
      {apiOk === false && (
        <div className="banner-error" role="alert">
          <span>
            API unreachable at <code>/api</code>. Make sure{' '}
            <code>bun run api</code> is running on port 4317.
          </span>
          <button
            type="button"
            className="button"
            onClick={() => void checkHealth()}
            disabled={healthChecking}
          >
            {healthChecking ? 'Checking...' : 'Retry'}
          </button>
        </div>
      )}
      <div className="tabs">
        <button className={`tab ${tab === 'search' ? 'active' : ''}`} onClick={() => setTab('search')}>
          Search
        </button>
        <button className={`tab ${tab === 'ask' ? 'active' : ''}`} onClick={() => setTab('ask')}>
          Ask
        </button>
      </div>
      {tab === 'search' ? (
        <Search availableSources={availableSources} connectors={connectors} />
      ) : (
        <Ask availableSources={availableSources} connectors={connectors} />
      )}
    </div>
  );
}
