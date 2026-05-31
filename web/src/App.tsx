import { useEffect, useState } from 'react';

const KNOWN_SOURCES = [
  'm365-calendar',
  'm365-mail',
  'm365-sharepoint',
  'm365-teams',
  'acumatica',
  'pipedrive',
];

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

function SourceChips({ value, onChange }: { value: Set<string>; onChange: (s: Set<string>) => void }) {
  return (
    <div className="sources">
      {KNOWN_SOURCES.map((s) => {
        const on = value.has(s);
        return (
          <span
            key={s}
            className={`chip ${on ? 'on' : ''}`}
            onClick={() => {
              const next = new Set(value);
              if (on) next.delete(s);
              else next.add(s);
              onChange(next);
            }}
          >
            {s}
          </span>
        );
      })}
    </div>
  );
}

function Search() {
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
      <div className="row">
        <input
          className="input"
          placeholder="Search the company brain..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <button className="button" onClick={run} disabled={loading}>
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>
      <SourceChips value={sources} onChange={setSources} />
      {error && <ErrorDisplay message={error} />}
      {hits && hits.length === 0 && <div>No results.</div>}
      {hits?.map((h, i) => (
        <div key={`${h.slug}-${i}`} className="result">
          <h3>{h.title || h.slug}</h3>
          <div className="meta">
            {h.source_id ? `${h.source_id} · ` : ''}
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

function Ask() {
  const [question, setQuestion] = useState('');
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <div className="row">
        <input
          className="input"
          placeholder="Ask a question..."
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <button className="button" onClick={run} disabled={loading}>
          {loading ? 'Asking...' : 'Ask'}
        </button>
      </div>
      <SourceChips value={sources} onChange={setSources} />
      {error && <ErrorDisplay message={error} />}
      {answer && (
        <>
          <div className="answer">{answer.text}</div>
          {answer.citations.length > 0 && (
            <div>
              <strong>Citations</strong>
              <ul>
                {answer.citations.map((c) => (
                  <li key={c.slug} className="citation">
                    [{c.source_id}] {c.title ?? c.slug}
                  </li>
                ))}
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
  useEffect(() => {
    fetch('/api/health')
      .then((r) => setApiOk(r.ok))
      .catch(() => setApiOk(false));
  }, []);
  return (
    <div className="container">
      <h1>
        company-brain {apiOk === false && <span className="error">(API offline)</span>}
      </h1>
      <div className="tabs">
        <button className={`tab ${tab === 'search' ? 'active' : ''}`} onClick={() => setTab('search')}>
          Search
        </button>
        <button className={`tab ${tab === 'ask' ? 'active' : ''}`} onClick={() => setTab('ask')}>
          Ask
        </button>
      </div>
      {tab === 'search' ? <Search /> : <Ask />}
    </div>
  );
}
