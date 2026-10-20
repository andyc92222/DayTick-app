#!/bin/bash
set -euo pipefail
# Bootstrap only when absent. GCE reruns this script on subsequent boots.
# Existing Docker packages must never be upgraded as a side effect of a restart.
if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable' \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# Fail on incomplete/manual installations rather than upgrading the engine.
docker compose version >/dev/null || { echo 'Docker Compose plugin missing; repair it explicitly.' >&2; exit 1; }
docker buildx version >/dev/null || { echo 'Docker Buildx plugin missing; repair it explicitly.' >&2; exit 1; }
# Does not restart an already running daemon. On the DB host, respects the
# mount guard installed before joining/deploying the Swarm stack.
systemctl enable --now docker
