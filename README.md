# DayTick

A personal daily countdown planner built for the INFS3208 Type I implementation. React + TypeScript + Vite, three independently containerized Python FastAPI services, PostgreSQL, and an Nginx gateway. Docker Compose supports local development; a Docker Swarm stack targets Google Cloud Compute Engine.

## Features

- Register, sign in, sign out, and keep a private task list.
- Create, edit, delete, and manually complete today's tasks.
- Start, pause, resume, and reset a circular countdown.
- At most one running countdown per user, including requests handled by different replicas.
- Display **Time Up** at zero; expiry does not complete a task.
- Restore tasks and countdown state after refreshes and service restarts.
- Responsive desktop/mobile interface with keyboard-accessible forms and controls.

Daily summaries, historical analytics, collaboration, notifications, and Pomodoro features are intentionally excluded.

## Run locally with Docker Compose

Install Docker Engine with Compose v2 (or Docker Desktop using Linux containers) and Node.js 24. Run from the repository root:

```sh
# Generate random local credentials and an RSA signing key; existing secrets are preserved.
node scripts/setup.mjs

# Validate, build, and wait for all services to become healthy.
docker compose config --quiet
docker compose up --build --wait --wait-timeout 240
```

Open **http://localhost:8080**. Register an account; there are no seeded accounts or default passwords. You do not need Python or npm dependencies on the host for the containerized app.

```sh
# View service state and logs.
docker compose ps
docker compose logs --tail=100 auth task timer gateway

# Check persistence after restarting the application containers.
docker compose restart auth task timer

# Exercise replica routing; the gateway has the only published application port.
docker compose up -d --scale task=2 --scale timer=2

# Stop containers and preserve the database volume.
docker compose down
```

PostgreSQL data lives in the `daytick_postgres_data` named volume. Do not remove that volume when you want to preserve data. Secret files must be retained alongside the volume; generating new passwords does not change existing database roles. Database credentials can be rotated with a coordinated database password update and secret replacement.

Configuration defaults are in `.env.example`. `.env` and `.secrets/` are ignored by Git and excluded from Docker build contexts. Set `APP_TIMEZONE` in `.env` before starting; the default is `Australia/Brisbane`. `HTTP_PORT`, `JWT_ISSUER`, `JWT_AUDIENCE`, and `JWT_TTL_SECONDS` are configurable. The initial database name defaults to `daytick`; use a fresh volume if changing it during development.

## Repository

```text
frontend/                  React dashboard, API client, display tests, Dockerfile
services/auth/             Registration, password hashing, JWT issuance
services/task/             Task CRUD, ownership, timezone boundaries, completion
services/timer/            Countdown lifecycle, atomic locking, retry fencing
  each service/app/        FastAPI application
  each service/migrations/ Service-owned, idempotent SQL migration
  each service/Dockerfile  Independent runtime image
shared/                    Configuration, database connections, JWT verification, health checks
infrastructure/nginx/      Gateway image, routing, browser security headers
infrastructure/postgres/   Fresh-volume role/schema initialization
infrastructure/swarm/      Multi-host stack and GCE startup script
scripts/                   Setup, native dev runner, build/push, deploy, Compose verification
tests/                     Auth, task, timer, recovery, configuration, browser tests
.github/workflows/ci.yml   Automated native-API and Compose verification workflow
compose.yml                Local application stack
compose.test.yml           Test-only loopback PostgreSQL port
pyproject.toml / uv.lock   Locked Python dependencies
requirements.lock          Hash-locked runtime dependencies for Docker
package-lock.json          Browser/development tooling lock
```

## Architecture and data ownership

```text
Browser → Nginx gateway → Frontend static assets
                       → Auth Service  → auth.users
                       → Task Service  → task.tasks
                       → Timer Service → timer.timer_sessions

Timer → Task over HTTP: verify task ownership and availability
Task  → Timer over HTTP: synchronize completion, deletion, or duration change
Timer → Task over internal HTTP: verify the pending operation before synchronization
```

All three services use PostgreSQL, with different login roles and private schemas. Each service owns its migrations and tables; none reads another service's tables. Cross-service references are UUIDs rather than database foreign keys. The shared package contains infrastructure helpers, not shared domain tables. Every container embeds the helpers and its own service, so deployments do not require a shared runtime filesystem.

Migrations run at startup under a service-specific PostgreSQL advisory lock, allowing concurrent replica startups. SQL is idempotent; the current schema includes an additive upgrade for operation fencing. Future upgrades should remain backward-compatible during rolling updates and have an explicit migration/backfill plan. Application rollback does not roll back database data or schema changes.

Users, tasks, and timer sessions use UUID primary keys and UTC `TIMESTAMPTZ` fields. Today's list uses task creation time and midnight boundaries in `APP_TIMEZONE`, including daylight-saving transitions. Existing tasks remain stored when the day changes; no historical browsing or analytics interface is provided. A running task from an earlier day is pinned in the dashboard so it can still be controlled.

### Countdown authority and concurrency

A running timer stores an absolute `ends_at` timestamp; a paused timer stores its remaining seconds. There is no per-second database update and no in-memory authoritative countdown. The browser interpolates a server snapshot with a monotonic clock and resynchronizes every ten seconds, on focus, and after actions. Network latency can cause a small visual offset, which the next synchronization corrects. Server actions always use database state and database time.

Timer requests acquire a transaction-level advisory lock derived from the authenticated user's UUID. They reconcile expired sessions before updating state. A partial unique index on `user_id WHERE status='running'` independently enforces the one-running-timer rule. Locks and the index work across processes and hosts sharing the database. Pausing a different task does not silently stop the current timer; a conflicting start returns `409`.

Task duration changes, completion, and deletion use a retryable workflow:

1. Serialize mutations for that user with a separate Task advisory lock.
2. Commit a pending task state and operation UUID, blocking new timer starts.
3. Ask Timer to synchronize under its user lock. Timer verifies the current operation over internal HTTP, fencing delayed requests.
4. Commit the final task state, or remove the task after timer cleanup.

If a dependency fails, the task remains visibly pending. Use its **Retry** control to finish the same operation after recovery. Repeating the API operation is also supported. Duration changes require an idle/reset timer; a conflict restores the task's active state. Completion stops the countdown, and deletion removes the timer. There is no distributed transaction and no autonomous background retry worker.

### Authentication

Passwords use Argon2id. Auth issues RS256 JWTs with required subject, issued-at, expiry, issuer, and audience claims. All services verify the signature, fixed algorithm, expiry, issuer, audience, and UUID subject. Only Auth receives the private signing key; Task and Timer receive the public key. Authorization always derives the user ID from the JWT, and unowned resources return `404`.

The browser keeps its access token in `sessionStorage` to survive refreshes in the same tab. Sign-out clears the token and private UI state. Tokens expire after one hour by default; there is no refresh token or immediate server-side revocation. Tokens already copied elsewhere remain valid until expiry. The gateway applies a restrictive content security policy and blocks `/internal/`; internal service APIs also require a separate random service credential. No backend or database ports are publicly published by the default stack.

## HTTP API

All protected requests include `Authorization: Bearer <access_token>`. IDs are UUIDs; timestamps are UTC ISO 8601. Public request models reject unexpected fields, including frontend-supplied ownership IDs. Durations are integers from 1 to 86,400 seconds; task titles contain 1–200 trimmed characters; passwords contain 10–128 characters.

| Method | Path | Request / behavior |
|---|---|---|
| POST | `/api/auth/register` | `{email,password}` → token, user, expiry, timezone (`201`) |
| POST | `/api/auth/login` | `{email,password}` → token, user, expiry, timezone |
| GET | `/api/auth/me` | Authenticated user and configured timezone |
| GET | `/api/tasks/today` | `{tasks,timezone,server_time}` |
| POST | `/api/tasks` | `{title,planned_duration_seconds}` → task (`201`) |
| GET | `/api/tasks/{id}` | Owned task |
| PATCH | `/api/tasks/{id}` | Optional `title` and/or `planned_duration_seconds` |
| DELETE | `/api/tasks/{id}` | Delete owned task and timer (`204`) |
| POST | `/api/tasks/{id}/complete` | Complete owned task and stop countdown |
| GET | `/api/timers` | `{timers,server_time}` for authenticated user |
| GET | `/api/timers/{task_id}` | Owned task's timer, or virtual idle state |
| POST | `/api/timers/{task_id}/start` | Idle → running |
| POST | `/api/timers/{task_id}/pause` | Running → paused |
| POST | `/api/timers/{task_id}/resume` | Paused → running |
| POST | `/api/timers/{task_id}/reset` | Any active task's timer → idle, full duration |

An expired timer must be reset before restarting. Duplicate start/resume requests on an already running timer and duplicate pause requests on a paused timer are harmless. Reset is idempotent. Completion is idempotent; an already deleted task returns `404`.

Timer responses include `task_id`, `status`, `planned_duration_seconds`, `remaining_seconds`, `ends_at`, and `server_time`. Stored timers additionally include session IDs and timestamps. Status is `idle`, `running`, `paused`, or `expired`. Task status is `active`, `completed`, or a pending workflow state (`updating`, `completing`, `deleting`).

Errors: `401` invalid authentication, `404` absent/unowned resource, `409` conflicting state, `422` invalid input, and `503` unavailable database/dependency. Each service exposes `/health/live`, `/health/ready`, `/docs`, and `/openapi.json` on its internal port. Readiness checks PostgreSQL; dependency failures are reported per operation rather than causing a circular readiness dependency. The gateway exposes its own `/health/live`.

## Development without Docker

The native runner uses a portable PostgreSQL distribution supplied by npm; it does not install a system database service. Before startup it copies the native binaries and DLLs into a versioned directory under `.local/postgres-runtime/`. PostgreSQL runs from that copy, so Windows does not lock files inside `node_modules` during dependency installation. Use Node 24 and `uv` with Python 3.12 support.

```sh
node scripts/setup.mjs
uv sync --locked --python 3.12
npm ci
npm --prefix frontend ci

# Terminal 1: persistent loopback-only PostgreSQL on port 55432.
npm run dev:db

# Terminal 2: FastAPI ports 8001–8003 and Vite port 5173.
uv run python scripts/native.py
```

Open **http://127.0.0.1:5173**. Vite proxies API requests to the appropriate service. Ctrl+C stops the runner and its child processes. Native database files are under `.local/postgres/`; logs are under `.local/`. Do not run the native application runner while native integration tests are using the same service ports. On Windows use `npm.cmd`/`npx.cmd` if PowerShell blocks npm's `.ps1` launcher.

To review the production bundle locally, first run `npm --prefix frontend run build`, then use `uv run python scripts/native.py --preview` and open **http://127.0.0.1:4173**.

### Windows PowerShell commands

Run these once from the repository root, with DayTick's app runner stopped:

```powershell
Set-Location 'C:\Users\andyc\Documents\GitHub\DayTick app'
node scripts/setup.mjs
uv sync --locked --python 3.12
npm.cmd ci --include=dev --include=optional
npm.cmd --prefix frontend ci
```

Start the database in terminal 1:

```powershell
npm.cmd run dev:db
```

Start the frontend and all three backend services in terminal 2:

```powershell
uv run python scripts/native.py
```

Open **http://127.0.0.1:5173**. To stop the app, press Ctrl+C in terminal 2. To stop PostgreSQL cleanly, press Ctrl+C in terminal 1, or run this from another terminal:

```powershell
npm.cmd run dev:db:stop
```

The stop command targets only this checkout's `.local/postgres` cluster and uses PostgreSQL's `pg_ctl` fast shutdown. It does not delete data or regenerate credentials. The cached stop path works even if npm dependencies are temporarily missing. Keep `.local/postgres/` and `.secrets/`; `.local/postgres-runtime/` contains executable copies, not database data. Startup refuses automatic major-version upgrades and refuses initialization over a nonempty unrecognized data directory.

If `npm ci` previously failed with `EPERM ... libintl-9.dll`, an older DayTick database may still be running directly from `node_modules`. Stop that database from its original terminal before reinstalling. A failed clean install can leave packages missing, causing `ERR_MODULE_NOT_FOUND`; rerun the root install command after stopping the old server. Install frontend dependencies separately using the command above. Do not delete the database, lockfile, or secrets to fix dependency installation. Do not use blanket `taskkill /IM postgres.exe` or `taskkill /IM node.exe` commands.

Launcher regression checks: `npm.cmd run test:local-setup`. PostgreSQL diagnostic logs are under `.local/postgres.log`.

## Tests

```sh
# Source/configuration/display checks.
uv run ruff check shared services scripts tests
npm run test:config
npm --prefix frontend test
npm --prefix frontend run build

# Full native API suite. Start npm run dev:db first; stop the native app runner.
# Bash:
DAYTICK_TEST_NATIVE=1 uv run pytest -q
# PowerShell equivalent:
# $env:DAYTICK_TEST_NATIVE='1'; uv run pytest -q

# Browser tests. Start the native app runner again, then install Chromium once.
npx playwright install chromium
npm run test:e2e
```

Playwright runs the same three scenarios in desktop and mobile Chromium. Browser traces are disabled because network traces can capture credentials. Failure screenshots and locally generated review screenshots are ignored by Git.

For a fully containerized application test, install tooling and Chromium, then use:

```sh
# Linux/macOS:
sh scripts/verify-compose.sh
# Windows PowerShell:
# ./scripts/verify-compose.ps1
```

The scripts build and wait for Compose, run API tests through Nginx, then run browser tests through Nginx. API tests create unique disposable accounts and tasks. Use a development stack. Without `DAYTICK_TEST_NATIVE=1` or `DAYTICK_API_URL`, integration tests are explicitly skipped. Native-only tests inspect database role isolation, stored password hashes, date boundaries, retry fencing, and restart/dependency failures. These are explicitly skipped against a remote API because they require process/database control.

The CI workflow tests the native services against PostgreSQL 17 exposed only on loopback by `compose.test.yml`, then builds the full Compose stack and tests the public gateway. The workflow is supplied but has not been executed in this working session.

See [TESTING.md](TESTING.md) for actual results and remaining environment limitations.

## Google Cloud Compute Engine and Docker Swarm

**Prepared, not cloud-verified.** No GCE resources have been created and no cloud deployment, routing mesh, rolling update, or rollback has been tested in this working session. Follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for commented commands covering:

1. Artifact Registry and three Ubuntu GCE nodes in a private VPC.
2. Swarm membership and restricted cluster firewall rules.
3. Persistent Disk storage and PostgreSQL node placement.
4. Image publication, secret installation, and stack deployment.
5. IAP-only preview, an HTTPS load balancer for public use, scaling, updates, rollback, backups, and recovery.

The stack deploys two replicas each of Auth, Task, Timer, Frontend, and Nginx, using Swarm VIP load balancing and ingress routing. App updates use one replica at a time, start-first ordering, health checks, restart policies, and automatic rollback on update failure. PostgreSQL has one replica and stop-first updates, constrained to one labeled node with persistent disk storage. There is no automatic PostgreSQL failover: a database-node outage requires recovery of that node or manual disk reattachment and relabeling. Persistence does not replace backups.

## References

- [FastAPI password hashing and JWT authentication](https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/)
- [PostgreSQL transaction-level advisory locks](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)
- [Docker Swarm stack deployment](https://docs.docker.com/engine/swarm/stack-deploy/) and [service updates/rollback](https://docs.docker.com/engine/swarm/services/)
- [GCE instance creation](https://cloud.google.com/compute/docs/instances/create-start-instance)
