# Jerry adapter (jerry-app)

Sits between Traction (Vercel) and the real `/opt/jerry` service.
Bound to `127.0.0.1:8910`. Front it with whatever HTTPS / tunnel
pattern already exists on `jerry-app` (Caddy, nginx, Cloudflare
tunnel, Tailscale Funnel, etc.) — **never** expose port 8910 directly
to the internet.

```
Traction (Vercel)
  └─ HTTPS ──→  jerry-app HTTPS front (existing tunnel/proxy)
                  └─ http://127.0.0.1:8910  (this adapter)
                      └─ http://127.0.0.1:8900/v1/jerry/query  (real /opt/jerry)
```

The adapter is a single dependency-free Node script (`server.js`).
Anything that ships Node 20+ runs it.

---

## 0. Prerequisites on `jerry-app`

```bash
node --version          # >= 20
id jerry || sudo useradd --system --shell /usr/sbin/nologin --home /opt/jerry jerry
sudo mkdir -p /opt/jerry-adapter /var/log/jerry-adapter
sudo chown jerry:jerry /opt/jerry-adapter /var/log/jerry-adapter
```

## 1. Stand up `/opt/jerry` (the real Jerry) as a service

If it's not already a managed service:

```bash
sudo cp jerry.service.example /etc/systemd/system/jerry.service
sudoedit /etc/systemd/system/jerry.service     # adjust ExecStart for how /opt/jerry actually launches
sudo tee /etc/jerry.env >/dev/null <<'EOF'
# whatever Jerry needs in its env (vault paths, model keys, …)
EOF
sudo chmod 600 /etc/jerry.env
sudo systemctl daemon-reload
sudo systemctl enable --now jerry.service
sudo systemctl status jerry.service --no-pager
curl -sf http://127.0.0.1:8900/health && echo OK
curl -sf -X POST http://127.0.0.1:8900/v1/jerry/query \
  -H 'Content-Type: application/json' \
  -d '{"question":"ping"}' | head -c 200
```

The two `curl` checks must succeed before continuing.

## 2. Install the adapter

```bash
# from your laptop:
scp ops/jerry-adapter/server.js                jerry-app:/tmp/
scp ops/jerry-adapter/jerry-adapter.service    jerry-app:/tmp/

# on jerry-app:
sudo install -o jerry -g jerry -m 0755 /tmp/server.js /opt/jerry-adapter/server.js
sudo install -m 0644 /tmp/jerry-adapter.service /etc/systemd/system/jerry-adapter.service

ADAPTER_KEY="$(openssl rand -hex 32)"
sudo tee /etc/jerry-adapter.env >/dev/null <<EOF
ADAPTER_PORT=8910
ADAPTER_KEY=${ADAPTER_KEY}
JERRY_URL=http://127.0.0.1:8900
JERRY_TIMEOUT_MS=30000
EOF
sudo chmod 600 /etc/jerry-adapter.env
sudo chown root:jerry /etc/jerry-adapter.env
echo "ADAPTER_KEY=${ADAPTER_KEY}"      # <-- save this; Traction needs it as JERRY_ADAPTER_KEY

sudo systemctl daemon-reload
sudo systemctl enable --now jerry-adapter.service
sudo systemctl status jerry-adapter.service --no-pager
sudo journalctl -u jerry-adapter.service -n 50 --no-pager
```

Verify on the box:

```bash
curl -sf http://127.0.0.1:8910/health
KEY="$(grep ADAPTER_KEY /etc/jerry-adapter.env | cut -d= -f2)"
curl -sf -X POST http://127.0.0.1:8910/jerry/query \
  -H "Authorization: Bearer ${KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"ping"}' | head -c 400
```

Both calls must return JSON.

## 3. Front the adapter with HTTPS

Use whatever tunnel / proxy pattern is already on `jerry-app`. The
**only** rule: terminate TLS publicly and forward to
`http://127.0.0.1:8910`. Do not expose `127.0.0.1:8900` (raw Jerry).

Caddy example:

```caddyfile
jerry.your-domain.com {
  reverse_proxy 127.0.0.1:8910
  log
}
```

Cloudflare tunnel example (`/etc/cloudflared/config.yml`):

```yaml
ingress:
  - hostname: jerry.your-domain.com
    service: http://127.0.0.1:8910
  - service: http_status:404
```

Verify from a different machine:

```bash
curl -sfI https://jerry.your-domain.com/health
curl -sf -X POST https://jerry.your-domain.com/jerry/query \
  -H "Authorization: Bearer ${KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"ping"}'
```

## 4. Wire Traction (Vercel)

Add two project env vars on Vercel:

| name                    | value                                        |
|---|---|
| `JERRY_ADAPTER_URL`     | `https://jerry.your-domain.com`              |
| `JERRY_ADAPTER_KEY`     | the ADAPTER_KEY printed in step 2            |

Optional overrides:

| name              | default        | use                                            |
|---|---|---|
| `JERRY_PATH`      | `/jerry/query` | change only if your tunnel rewrites the path   |
| `JERRY_TIMEOUT_MS`| `30000`        | per-request budget                             |

Redeploy. The dock should now reach Jerry instead of saying "not configured".

## 5. Wire shape (what the adapter receives + returns)

Adapter → in:

```json
{
  "prompt": "string",
  "org": { "orgId": "...", "orgName": "BLCS", "orgSlug": "bl" },
  "actor": { "personId": "...", "name": "Tim Clark", "email": "...", "role": "admin" },
  "week": { "weekId": "...", "weekEndingDate": "2026-05-11", "quarter": "Q2 2026" },
  "meeting": { "nextScheduledFor": "2026-05-19T15:00:00Z" },
  "scorecard": [ { "measurableId":"...","name":"...","ownerName":"...",
                   "goalDirection":"gte","goalValue":100000,"formatHint":"currency_usd",
                   "currentActual":46577,"history":[{"weekEndingDate":"2026-05-04","actual":69115}] } ],
  "rocks":   [ { "rockId":"...","description":"...","ownerName":"...","status":"on_track","notes":null,"quarter":"Q2 2026" } ],
  "todos":   [ { "todoId":"...","description":"...","ownerName":"...","dueDate":"2026-05-20","status":"open","rolloverCount":0,"notes":null } ],
  "issues":  [ { "issueId":"...","title":"...","ownerName":"...","priority":"high","status":"open","rootCause":null } ],
  "readiness":[ { "personName":"...","obligated":true,"status":"red","label":"...","missingMeasurables":2,"totalMeasurables":3,"overdueTodos":1 } ],
  "transcripts":[ { "transcriptId":"...","meetingDate":"2026-05-04","source":"fireflies","durationSec":3600,"hasUtterances":true } ]
}
```

The adapter flattens this into a single `question` string and calls
real Jerry on `127.0.0.1:8900/v1/jerry/query` with
`{ question, session_id }`. `session_id` is keyed `${orgId}:${personId}`
so Jerry has continuity per user per org.

Adapter ← out:

```json
{
  "reply":      "string",                         // mapped from real Jerry's `answer`
  "citations":  [ { "source":"...","snippet":"...","href":"..." } ],
  "actionIntents": [ ... ],                       // mapped from real Jerry's `tool_calls`
                                                  //   only entries matching a known intent kind
                                                  //   are surfaced; unknown tool_calls are dropped
  "jerryVersion": "string"                        // mapped from real Jerry's `version`
}
```

## 6. Auth model

- **Adapter ↔ Traction**: bearer token (`ADAPTER_KEY`) over HTTPS via
  the public tunnel. Required.
- **Adapter ↔ real Jerry**: none. Loopback-only on `127.0.0.1:8900`.
  Real Jerry is not reachable from outside the box.

## 7. Checklist before declaring done

- [ ] `systemctl is-active jerry.service` → active
- [ ] `systemctl is-active jerry-adapter.service` → active
- [ ] `curl http://127.0.0.1:8900/health` → 200
- [ ] `curl http://127.0.0.1:8910/health` → 200
- [ ] `curl https://jerry.your-domain.com/health` → 200
- [ ] Vercel env vars set; redeploy triggered
- [ ] Sign in to Traction → click "ask jerry" → ask a question → reply renders
