#!/bin/bash
# Shared by the two Cloud Shell entry points. Never changes gcloud's active project.
set -Eeuo pipefail
REGION=australia-southeast1
ZONE=australia-southeast1-b
PROJECT_ID=
TAG=
CREATED=()
fail() { echo "ERROR: $*" >&2; echo "No cleanup performed. Completed changes: ${CREATED[*]:-none recorded}." >&2; exit 1; }
trap 'rc=$?; echo "Stopped (exit $rc). No resources were deleted. Completed changes: ${CREATED[*]:-none recorded}. Inspect the named project before rerunning." >&2' ERR
parse_args() {
  for arg in "$@"; do
    case "$arg" in
      --project-id=*) PROJECT_ID=${arg#*=} ;;
      --tag=*) TAG=${arg#*=} ;;
      --help|-h) echo "Usage: bash $0 --project-id=PROJECT_ID [--tag=RELEASE_TAG (setup-swarm only)]"; exit 0 ;;
      *) fail "Unknown argument: $arg. Use --project-id=YOUR_PROJECT_ID." ;;
    esac
  done
  [[ "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail 'Supply a valid Google Cloud Project ID (not its display name).'
  [[ -z "$TAG" || "$TAG" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,100}$ ]] || fail 'Invalid release tag.'
  for tool in gcloud python3 tar; do command -v "$tool" >/dev/null || fail "Missing $tool; use Google Cloud Shell."; done
  cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
}
gc() { gcloud --project="$PROJECT_ID" "$@"; }
confirm_project() {
  local description billing answer
  description=$(gc projects describe "$PROJECT_ID" --format='value(name,projectId,lifecycleState)')
  [[ "${description##*$'\t'}" == ACTIVE ]] || fail 'Project is not ACTIVE or is inaccessible.'
  printf 'Selected project (name, ID, state): %s\n' "$description"
  billing=$(gc billing projects describe "$PROJECT_ID" --format='value(billingEnabled)')
  [[ "${billing,,}" == true ]] || fail 'Billing is disabled or cannot be verified. Ask the project owner for billing visibility.'
  echo 'This operation uses chargeable VMs, disks, external IPv4 addresses and image storage.'
  read -r -p "Type the Project ID ($PROJECT_ID) to continue: " answer
  [[ "$answer" == "$PROJECT_ID" ]] || fail 'Project confirmation did not match.'
}
# list rather than describe-or-create: an IAM/API failure must not be treated as absence.
exists() { local result; result=$(gc "$@" --format='value(name)') || fail 'Resource lookup failed; refusing to assume it does not exist.'; [[ -n "$result" ]]; }
ssh_node() {
  local node=$1; shift
  gc compute ssh "$node" --zone="$ZONE" --tunnel-through-iap --quiet --command="set -e; $*"
}
# Validate JSON with a small Python expression. Never handles secret material.
check_json() {
  python3 -c 'import json,sys; d=json.load(sys.stdin); assert eval(sys.argv[1], {"d":d}), sys.argv[2]' "$1" "$2"
}
