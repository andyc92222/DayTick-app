$ErrorActionPreference = 'Stop'
# Requires Docker Desktop with Linux containers, Node 24, and uv.
node scripts/setup.mjs
if ($LASTEXITCODE) { throw 'Setup failed' }
docker compose config --quiet
if ($LASTEXITCODE) { throw 'Compose configuration invalid' }
docker compose up --build --wait --wait-timeout 240
if ($LASTEXITCODE) { throw 'Compose failed to become healthy' }
$env:DAYTICK_API_URL = 'http://localhost:8080'
Remove-Item Env:DAYTICK_TEST_NATIVE -ErrorAction SilentlyContinue
uv run --frozen pytest -q
if ($LASTEXITCODE) { throw 'API tests failed' }
$env:DAYTICK_E2E_URL = $env:DAYTICK_API_URL
npm.cmd run test:e2e
if ($LASTEXITCODE) { throw 'Browser tests failed' }
# Keep containers and persistent data for review. Stop with: docker compose down
