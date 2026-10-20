#!/bin/sh
set -eu
# Run on a Swarm manager from the repository root. No cloud resources are created here.
: "${REGISTRY:?Set REGISTRY}"
: "${TAG:?Set an immutable release TAG}"
for secret in postgres_password auth_db_password task_db_password timer_db_password jwt_private jwt_public internal_token; do
  if ! docker secret inspect "daytick_${secret}_v1" >/dev/null 2>&1; then
    docker secret create "daytick_${secret}_v1" ".secrets/$secret" >/dev/null
  fi
done
if ! docker config inspect daytick_postgres_init_v1 >/dev/null 2>&1; then
  docker config create daytick_postgres_init_v1 infrastructure/postgres/init.sh >/dev/null
fi
docker stack config -c infrastructure/swarm/stack.yml >/dev/null
docker stack deploy --with-registry-auth --resolve-image always -c infrastructure/swarm/stack.yml daytick
docker stack services daytick
# Watch convergence: docker stack ps daytick --no-trunc
# Scale: docker service scale daytick_task=3 daytick_timer=3
# Roll back a bad app release: docker service rollback daytick_timer
# Update TAG in your shell/deployment record after rollback before the next stack deployment.
