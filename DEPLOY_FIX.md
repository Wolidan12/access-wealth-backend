# Fix: "NETWORK ERROR PLEASE CHECK UR CONECTION" on sign-in

## What is actually happening (diagnosed 2026-08-13)

The sign-in form is NOT failing because of wrong credentials or bad code.
The backend container on Railway is unreachable right now — the Railway edge
returns **502 Bad Gateway** for every request, including `/health`.

Verified live while diagnosing:

- `https://access-wealth-backend-production.up.railway.app/health` → **502**
- `https://accesswealthhq.com/api/health` → **502**
- `https://accesswealthhq.com/api/login` → **502**
- `https://accesswealthhq.com/` (static frontend on Netlify) → **200 OK**

### The chain of failure

1. User submits the login form on `accesswealthhq.com/login.html`.
2. The frontend calls `POST https://accesswealthhq.com/api/login`
   (`public/global.js` uses `/api` as the base URL in production).
3. Netlify's `netlify.toml` rewrites `/api/*` to
   `https://access-wealth-backend-production.up.railway.app/api/:splat`.
4. That Railway service has no healthy container, so Railway's gateway replies
   with an HTML 502 page (not JSON).
5. The browser can't parse it → the page shows a network-style error
   ("NETWORK ERROR PLEASE CHECK UR CONECTION" / "Unable to parse server
   response") — which looks like a connectivity problem even though the user's
   internet is fine.

### About the deploy log you pasted

```
Access Wealth API listening on port 3000
CORS configured for [https://accesswealthhq.com]
npm error ... signal SIGTERM
npm error command sh -c node server.js
Stopping Container
```

That is the **normal tail of a container being stopped during a redeploy**
(SIGTERM is Railway's stop signal; npm just reports that its child process was
terminated). The old container shut down — but the **new container never became
healthy** (deploy failed, was rolled back, or the service is paused/out of
credits). That is why every request now returns 502.

---

## Fix step-by-step (Railway dashboard)

### 1. Open the backend service

Railway project → the service that runs this repo (the one reachable at
`access-wealth-backend-production.up.railway.app`).

### 2. Check the latest deployment

Go to **Deployments** and look at the most recent entry:

| Status shown | What it means | What to do |
| --- | --- | --- |
| `Crashed` | The app exits at startup | Open the deploy log, read the `FATAL:` line, fix the cause (usually JWT_SECRET or the volume), then redeploy |
| `Failed` | Build failed | Open the build log and fix the error (e.g. build command/Node version) |
| `Removed` / only old deployments | The last deploy was rolled back or stopped | Click **Deploy** / redeploy from the repo |
| `Deploying...` for a long time | Healthcheck keeps failing | See step 4 |

### 3. Check the service is not paused / out of usage

Railway shows a paused service or a usage/credit limit banner on the service
page. If the account ran out of usage, the gateway answers 502 exactly like
this. Restore the plan/credits and the container comes back automatically.

### 4. Make the deploy pass its healthcheck

This repo now ships `railway.json` with:

```json
"healthcheckPath": "/health",
"healthcheckTimeout": 180,
"restartPolicyType": "ON_FAILURE",
"restartPolicyMaxRetries": 10
```

When that is in place, Railway only flips traffic to a container that answered
`/health` with `200`. If the healthcheck fails, read the deploy log — the
server now prints a clear `FATAL:` reason instead of dying silently.

### 5. Verify the required environment variables (service → Variables)

- `JWT_SECRET` — must be set. If missing, the app logs
  `ERROR: JWT_SECRET is not configured` and login returns 503 (it no longer
  crashes silently). Generate one, e.g. `openssl rand -hex 32`.
- `FRONTEND_URL` — `https://accesswealthhq.com` (comma-separated if you add
  more origins, e.g. `https://accesswealthhq.com,https://www.accesswealthhq.com`).
  Netlify proxies with `Origin: https://accesswealthhq.com`, which is already
  in the default allow-list, so this is optional but recommended to be explicit.
- `NODE_ENV=production` (recommended; keeps JWT secret handling strict).
- `RAILWAY_VOLUME_MOUNT_PATH` — must point at the mounted volume. The app
  stores `database.sqlite` there and now **exits with a FATAL message** if it
  cannot open the database, instead of serving broken endpoints.
- `PORT` — leave unset (defaults to 3000) or set 3000.
- `ADMIN_BOOTSTRAP_PASSWORD`, `SUPPORT_BOOTSTRAP_PASSWORD` — not needed for
  sign-in, but set them to auto-create the admin/support accounts.

### 6. Redeploy and verify

Redeploy from the latest commit, then check in a browser:

1. `https://access-wealth-backend-production.up.railway.app/health`
   must return `{"status":"ok","database":"ok","authentication":"ok"}`.
2. `https://accesswealthhq.com/api/health` must return the same JSON.
3. Sign in on `https://accesswealthhq.com/login.html` — it should now work.

If `/health` is OK but login still fails, open the browser DevTools → Network,
replay the login, and read the JSON error the API returns (invalid password,
suspended account, etc.) — with a healthy backend the API always answers with
a useful JSON message now.

---

## What changed in this repo (backend hardening)

- **`server.js`**
  - Fails fast with a clear `FATAL:` log if the SQLite database can't be
    opened (instead of serving every endpoint — including login — as a 500).
  - Added `GET /` and `GET /api` JSON identity routes so you can tell which
    service a domain actually points at.
  - Graceful SIGTERM/SIGINT shutdown with an 8s hard-exit guard, so deploy
    logs always show a clean close instead of a bare `signal SIGTERM`.
  - Logs `uncaughtException` stack traces instead of dying silently.
  - Startup summary logs (NODE_ENV, database path, JWT_SECRET configured?) so
    misconfigurations are visible in the deploy log at a glance.
- **`railway.json`** (new) — healthcheck on `/health`, restart on failure.

Note: `/health` already existed and returns 503 with a JSON reason when the
database or JWT secret is unavailable — the healthcheck uses that.
