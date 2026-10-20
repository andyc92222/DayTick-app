#!/bin/sh
set -eu
# Requires Docker Engine/Compose, Node 24, uv, and installed npm dependencies/Chromium.
node scripts/setup.mjs
docker compose config --quiet
docker compose up --build --wait --wait-timeout 240
unset DAYTICK_TEST_NATIVE
export DAYTICK_API_URL=http://localhost:8080
uv run --frozen pytest -q
export DAYTICK_E2E_URL="$DAYTICK_API_URL"
npm run test:e2e
# Keep data and containers for review; docker compose down stops them.
