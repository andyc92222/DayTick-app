#!/bin/sh
set -eu
# Run from the repository root after authenticating Docker to your registry.
# Example: REGISTRY=australia-southeast1-docker.pkg.dev/PROJECT/daytick TAG=v1 sh scripts/build-push.sh
: "${REGISTRY:?Set REGISTRY to your registry/repository path}"
: "${TAG:?Set TAG to a unique release tag}"
for service in auth task timer frontend gateway; do
  case "$service" in
    frontend) dockerfile=frontend/Dockerfile ;;
    gateway) dockerfile=infrastructure/nginx/Dockerfile ;;
    *) dockerfile="services/$service/Dockerfile" ;;
  esac
  docker build -f "$dockerfile" -t "$REGISTRY/daytick-$service:$TAG" .
  docker push "$REGISTRY/daytick-$service:$TAG"
done
