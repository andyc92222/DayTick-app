# DayTick verification record

## CI import-path correction — 21 October 2026

The GitHub Actions error `ModuleNotFoundError: No module named 'scripts'` was reproduced locally using the pytest console entry point. Added `pythonpath = ["."]` to `[tool.pytest.ini_options]` in `pyproject.toml` so pytest can import repository-local packages before loading `tests/conftest.py`.

After the change, console-entry-point collection found **42 tests**, and the offline run reported **25 passed, 17 skipped**. Skips require live API/database services or native process control. Both commands used `-p no:cacheprovider` to avoid an existing local pytest-cache permission issue. GitHub Actions and Docker-backed integration tests have not been rerun for this correction; these local results do not establish a passing CI run. The application runtime and cloud resources were unchanged.

## Earlier verification

Date: **18 October 2026**, Australia/Brisbane.

## Environment

- Windows x86-64, PowerShell.
- Node.js 24.17.0, npm 11.13.0.
- Python 3.12.14 installed into the project-local tool cache using uv 0.12.17.
- Real local PostgreSQL **18.4**, supplied by the optional `embedded-postgres` development package. Data retained under `.local/postgres/`; bound to loopback port 55432.
- Auth, Task, and Timer run as independent Uvicorn processes. Concurrency tests also start a second Timer replica on a separate port, sharing the same PostgreSQL database.
- Chromium installed by Playwright; desktop Chrome and iPhone-sized Chromium projects.
- Docker/Compose are not installed in this environment. Compose/Swarm target PostgreSQL **17**, which has not been run locally in this session. CI is configured to test PostgreSQL 17.

## Executed checks

| Check | Result | Evidence / scope |
|---|---|---|
| Authentication phase | **9 passed** | Registration, login, duplicate email, password validation, Argon2id storage, JWT signature/algorithm/expiry/issuer/audience/required expiry |
| Task phase | **5 passed** | CRUD, completion, ownership, rejected owner spoofing, today's date boundaries, DST, database role separation |
| Timer phase | **7 passed** | Lifecycle, expiry, concurrent starts through two replicas, user independence, ownership, duration synchronization, service restart and dependency outage recovery |
| Final complete backend suite | **25 passed; 0 skipped** | Above 21 checks plus database-unavailable readiness, start/completion race, stale internal retry fencing, and deletion of a running task |
| Frontend display suite | **3 passed** | Monotonic elapsed-time interpolation, paused persistence, clock formatting |
| Compose/Swarm/gateway static checks | **3 passed** | YAML merge resolution, component wiring, secret references, replica/update/storage settings, internal route blocking in source config |
| Browser suite against Vite development server | **6 passed** | Three end-to-end scenarios on desktop and mobile |
| Final browser suite against built production assets | **6 passed** | Same scenarios served by Vite preview on port 4173, using live FastAPI services and PostgreSQL |
| TypeScript and Vite production build | **Passed** | `npm --prefix frontend run build` |
| Ruff lint and formatting | **Passed** | `ruff check` and `ruff format --check` on shared code, services, scripts, and tests |
| Shell script syntax | **Passed** | Git Bash `bash -n` for build/push, Swarm deploy, Compose verify, PostgreSQL init, and GCE startup scripts |
| npm dependency audit | **0 vulnerabilities** | Root tooling and frontend dependency trees |
| Git whitespace check | **Passed** | `git diff --check` |
| Secret/build-artifact exclusion | **Passed** | Git ignores `.env`, `.secrets`, `.local`, `.venv`, `node_modules`, and built assets; Docker ignores secrets and local caches |

There are **37 unique automated test cases** across backend, frontend display, configuration, and browser suites. Repeated runs are not counted as additional unique coverage. The final full backend run completed without warnings; Playwright's environment emitted only its harmless `NO_COLOR`/`FORCE_COLOR` precedence notice.

### Browser scenarios

1. Register, create/edit a task, start a timer, refresh while running, pause, refresh while paused, resume, reset, manually complete, logout, login, and delete. Check that the page emits no JavaScript exceptions and does not overflow horizontally.
2. Run a one-second task, show Time Up, verify it remains manually completable, and refresh to confirm persisted expiry.
3. Open an independent authenticated browser context and verify another user's private task is absent.

Desktop and mobile screenshots were visually inspected. They are local review artifacts under `.local/`, not committed user data.

### Failure and concurrency coverage

- Eight different tasks compete to start for one user, with requests distributed between two Timer processes. Exactly one succeeds and seven receive `409`.
- A second user can run a timer independently.
- Timer process termination/restart preserves the exact running deadline and decreases remaining time as expected.
- A paused countdown retains exactly the stored remainder after Timer restart.
- A stopped Task process causes Timer actions to return `503`; actions work again after Task returns.
- A stopped Timer process leaves task completion visibly pending. A second Timer replica rejects new starts for that pending task. Repeating completion after recovery finishes cleanup.
- A competing task completion and timer start leave no running timer once completion succeeds.
- A fabricated stale internal operation UUID is rejected without changing timer duration.
- A simulated database connection failure makes readiness return `503` while liveness remains `200`.

## Issues found and resolved during implementation

- Native Python and PostgreSQL were initially unavailable; isolated project-local runtimes enabled real HTTP/database testing.
- Fixed the native runner's JWT secret filename mapping before authentication tests passed.
- Updated the frontend test runner after its initial dependency tree reported security advisories. Both final npm audits are clean.
- Enabled YAML merge-key interpretation in the static configuration test loader to match the Compose files' anchors.
- Added mutation serialization and operation UUID fencing to prevent delayed cross-service retries from applying stale changes.
- Replaced deprecated Starlette TestClient usage in the database-readiness test with HTTPX's ASGI transport.

## Not verified here

- Docker image builds, Dockerfile execution, actual Nginx configuration loading, Docker DNS, container health transitions, Compose startup, and named-volume container recovery. **Static checks do not establish runtime correctness.** `scripts/verify-compose.ps1` and `scripts/verify-compose.sh` are provided to run these checks once Docker is available.
- PostgreSQL 17 runtime compatibility. All local database tests used PostgreSQL 18.4; the supplied CI workflow targets the configured PostgreSQL 17 container.
- Disk recovery. Native PostgreSQL shutdown/restart was additionally exercised during the Windows repair recorded below; container/database-node recovery remains unverified.
- GitHub Actions execution. A workflow is included but has not run during this session.
- Any Google Cloud provisioning or deployment, Artifact Registry image publication, HTTPS certificate/load-balancer setup, multi-host Swarm routing, node drain/recovery, real rolling updates/rollback, or Persistent Disk reattachment and backup restoration.
- Safari/WebKit and Firefox. Mobile verification used Chromium with a mobile viewport/device profile.

The cloud runbook and stack are implementation artifacts, **not claims of tested cloud functionality**.

## Windows native dependency repair — 18 October 2026

The existing DayTick PostgreSQL parent process (PID 6632) and its worker processes were running from this checkout's `node_modules/@embedded-postgres/windows-x64/native/bin`. Process module inspection confirmed that parent PID 6632 had loaded `libintl-9.dll` from that directory. npm's attempted cleanup had already removed the `embedded-postgres` package and other package files, while Windows retained the loaded native files. This explains both `EPERM` and the subsequent missing-module error; it was not a package/lockfile version mismatch.

Only the identified DayTick app tree and database wrapper were stopped. Because the original control binary had been removed by the partial install, the pinned registry package was downloaded into a separate repair-tools directory and its `pg_ctl` performed a clean database shutdown. A stopped-cluster safety copy was saved under `.local/backups/postgres-before-repair-20261018-162308/`. The original `.local/postgres/` and `.secrets/` were preserved.

The launcher now copies the complete native distribution into a versioned `.local/postgres-runtime/` directory before starting it. The runtime copy is never overwritten during a reinstall. PostgreSQL starts and stops with `pg_ctl`, and an explicit `dev:db:stop` command also works independently of npm package imports. Root `pg` is now an explicit locked development dependency, rather than an implicit transitive dependency.

Executed during the repair:

- Root `npm.cmd ci` succeeded after shutting down the legacy database.
- Root `npm.cmd ci` also succeeded with the repaired PostgreSQL instance running from the isolated runtime. This directly exercises the original Windows locking regression.
- Database fingerprints immediately before and after that running-database reinstall matched, with 82 users, 84 tasks, and 28 timer sessions. The initial pre-shutdown SQL snapshot could not be read because the partial install had already broken backend-process startup; the stopped-cluster backup was retained instead.
- `npm.cmd run dev:db` reached ready on `127.0.0.1:55432`, using the existing database.
- `npm.cmd run dev:db:stop` shut down PostgreSQL cleanly, followed by a successful restart.
- Four native-launcher regression tests passed: independent complete runtime copying, reuse without overwriting active files, stop-path resolution without installed packages, invalid-path rejection, and actionable missing-dependency reporting (copy/reuse share one test).
- `npm.cmd --prefix frontend ci` repaired the separately incomplete frontend dependency tree. Its production build and three display tests passed.
- The full native backend suite passed again: 25 tests, with no skips.
- The repaired app launched successfully at `http://127.0.0.1:5173`; all six desktop/mobile end-to-end browser tests passed against the live frontend, three FastAPI services, and PostgreSQL.
- Ruff lint and launcher Prettier checks passed. Verification processes were stopped after testing, leaving the application ports free for normal startup.

No Docker or Google Cloud changes were part of this repair.
