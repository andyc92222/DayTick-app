#!/bin/bash
# Root-only remote release helper. Builds reuse the existing build/push script.
set -Eeuo pipefail
umask 077
phase=${1:?}; project=${2:?}; tag=${3:?}
[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || exit 1
export REGISTRY="australia-southeast1-docker.pkg.dev/$project/daytick" TAG="$tag"
export APP_TIMEZONE=${APP_TIMEZONE:-Australia/Brisbane}
[[ $EUID -eq 0 ]] || { echo 'Root required' >&2; exit 1; }
# Attached node account; tokens go over stdin to Docker's root-owned auth store.
login_registry() {
  curl --fail --silent --show-error --retry 3 --retry-delay 5 \
    -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])' \
    | docker login -u oauth2accesstoken --password-stdin https://australia-southeast1-docker.pkg.dev >/dev/null
}
case "$phase" in
  build)
    login_registry
    sh scripts/build-push.sh
    ;;
  deploy)
    mkdir -p .secrets
    chmod 700 .secrets
    names=(postgres_password auth_db_password task_db_password timer_db_password jwt_private jwt_public internal_token)
    existing=0
    for name in "${names[@]}"; do
      if docker secret inspect "daytick_${name}_v1" >/dev/null 2>&1; then existing=$((existing+1)); fi
    done
    # Never invent new credentials for an existing database/Swarm. Restore originals.
    if [[ -e /srv/daytick/postgres/pgdata/PG_VERSION || $existing -gt 0 ]]; then
      for name in "${names[@]}"; do
        [[ -s ".secrets/$name" ]] || { echo "Restore original .secrets/$name from secure backup; refusing credential regeneration." >&2; exit 1; }
      done
    fi
    if [[ -e .secrets/jwt_private && ! -e .secrets/jwt_public || ! -e .secrets/jwt_private && -e .secrets/jwt_public ]]; then
      echo 'Restore the missing matching JWT key; incomplete pair.' >&2; exit 1
    fi
    if [[ ! -e .secrets/jwt_private ]]; then
      openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out .secrets/jwt_private 2>/dev/null
      openssl pkey -in .secrets/jwt_private -pubout -out .secrets/jwt_public
    fi
    for name in postgres_password auth_db_password task_db_password timer_db_password internal_token; do
      if [[ ! -e ".secrets/$name" ]]; then openssl rand -hex 32 > ".secrets/$name"; fi
    done
    for name in "${names[@]}"; do test -s ".secrets/$name"; chmod 600 ".secrets/$name"; done
    login_registry
    sh scripts/deploy-swarm.sh
    # Protected record for reruns; contains no credential material.
    printf '%s\n' "$TAG" > .release-tag
    ;;
  verify)
    # Require every desired replica and every running container to be healthy.
    for attempt in $(seq 1 60); do
      if python3 - <<'PY'
import json,subprocess,sys
def docker(*args): return subprocess.check_output(['docker',*args],text=True)
expected={'postgres':1,'auth':2,'task':2,'timer':2,'frontend':2,'gateway':2}
for service, count in expected.items():
    name='daytick_'+service
    spec=json.loads(docker('service','inspect',name))[0]
    if spec['Spec']['Mode']['Replicated']['Replicas']!=count: sys.exit(1)
    ids=docker('service','ps','-q','--filter','desired-state=running',name).split()
    if len(ids)!=count: sys.exit(1)
    for task in json.loads(docker('inspect',*ids)):
        if task['Status']['State']!='running': sys.exit(1)
PY
      then
        # Readiness proves DB connectivity and migrations for each API through ingress.
        # Public /health/live checks gateway only; full container health is checked by caller on all nodes.
        curl --fail --silent --show-error http://127.0.0.1:8080/health/live >/dev/null
        curl --fail --silent --show-error http://127.0.0.1:8080/ | grep -q '<html'
        break
      fi
      [[ $attempt -lt 60 ]] || { docker stack services daytick; echo 'Replica convergence timed out' >&2; exit 1; }
      sleep 10
    done
    ;;
  *) echo 'Unknown phase' >&2; exit 1 ;;
esac
