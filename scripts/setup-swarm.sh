#!/bin/bash
# Cloud Shell orchestrator: Docker builds run on VM 1, not inside Cloud Shell.
source "$(dirname -- "${BASH_SOURCE[0]}")/gcp-common.sh"
parse_args "$@"
confirm_project
remote="/opt/daytick-$PROJECT_ID"
ips=()
for n in 1 2 3; do
  node="daytick-$n"
  info=$(gc compute instances describe "$node" --zone="$ZONE" --format=json)
  check_json 'd["status"]=="RUNNING" and d["networkInterfaces"][0]["subnetwork"].endswith("/daytick-subnet")' 'Run setup-gcp first; VM not ready or subnet mismatch' <<< "$info"
  ips+=("$(python3 -c 'import json,sys; print(json.load(sys.stdin)["networkInterfaces"][0]["networkIP"])' <<< "$info")")
  echo "Waiting for Docker startup on $node (up to 10 minutes)..."
  ready=false
  for attempt in $(seq 1 60); do
    if ssh_node "$node" 'sudo systemctl is-active --quiet docker && sudo docker info >/dev/null && sudo docker compose version >/dev/null && sudo docker buildx version >/dev/null'; then ready=true; break; fi
    sleep 10
  done
  [[ "$ready" == true ]] || fail "Docker not ready on $node. Check startup logs: sudo journalctl -u google-startup-scripts.service"
done
# Only allowlisted source files are staged. Never upload the local .env, .secrets or DB.
# The SSH shell must cd here before invoking root-only helpers. Keep root as
# owner and grant this VM's SSH primary group read/traverse, never write access.
# Do not recurse: .secrets stays root-only (700 directory / 600 files).
ssh_node daytick-1 "sudo mkdir -p '$remote'; sudo chown root:\"\$(id -gn)\" '$remote'; sudo chmod 750 '$remote'"
tar --exclude=node_modules --exclude=dist --exclude=__pycache__ --exclude=.pytest_cache \
  --exclude=.env --exclude='.env.*' --exclude=.secrets --exclude=.local --exclude=.venv \
  -czf - frontend services shared infrastructure scripts requirements.lock \
  | ssh_node daytick-1 "sudo tar -xzf - -C '$remote'"
CREATED+=(release-source-staged)
disk_type=$(ssh_node daytick-1 "sudo blkid -s TYPE -o value /dev/disk/by-id/google-daytick-postgres || true")
format_arg=
if [[ -z "$disk_type" ]]; then
  read -r -p 'New blank PostgreSQL disk: type FORMAT daytick-postgres to authorize initialization (existing data is refused): ' answer
  [[ "$answer" == 'FORMAT daytick-postgres' ]] || fail 'Disk initialization cancelled.'
  format_arg=--format-confirmed-empty
fi
ssh_node daytick-1 "cd '$remote'; if sudo test -f /etc/systemd/system/docker.service.d/daytick-postgres-mount.conf; then guard=true; else guard=false; fi; sudo DAYTICK_GUARD_WAS_INSTALLED=\$guard bash scripts/gcp-prepare-disk.sh $format_arg"
CREATED+=(disk-mounted-and-guarded)
# Initialize only inactive nodes. Refuse foreign clusters instead of force-leaving them.
state=$(ssh_node daytick-1 "sudo docker info --format '{{.Swarm.LocalNodeState}}'")
case "$state" in
  inactive) ssh_node daytick-1 "sudo docker swarm init --advertise-addr '${ips[0]}' >/dev/null" ;;
  active) ssh_node daytick-1 'sudo docker node ls >/dev/null' ;;
  *) fail "Unexpected Swarm state on daytick-1: $state" ;;
esac
cluster=$(ssh_node daytick-1 "sudo docker info --format '{{.Swarm.Cluster.ID}}'")
[[ -n "$cluster" && "$cluster" != '<no value>' ]] || fail 'VM 1 has no readable manager cluster ID.'
# Read identities from each actual VM, rather than trusting hostname prefixes in
# the manager inventory. Check every active VM before joining any inactive VM.
node_ids=()
for n in 1 2 3; do
  node="daytick-$n"
  state=$(ssh_node "$node" "sudo docker info --format '{{.Swarm.LocalNodeState}}'")
  case "$state" in
    inactive) node_ids+=("") ;;
    active)
      other=$(ssh_node "$node" "sudo docker info --format '{{.Swarm.Cluster.ID}}'")
      [[ "$other" == "$cluster" ]] || fail "$node belongs to another Swarm or is not a manager; refusing to modify it."
      ssh_node "$node" 'sudo docker node ls >/dev/null'
      node_ids+=("$(ssh_node "$node" "sudo docker info --format '{{.Swarm.NodeID}}'")")
      ;;
    *) fail "Unexpected Swarm state on $node: $state" ;;
  esac
done
validate_members() {
  ssh_node daytick-1 'sudo docker node inspect $(sudo docker node ls -q)' \
    | python3 scripts/gcp-validate-swarm.py "$1" "$PROJECT_ID" "$ZONE" "${ips[@]}" "${node_ids[@]}"
}
validate_members partial
for n in 2 3; do
  node="daytick-$n"
  state=$(ssh_node "$node" "sudo docker info --format '{{.Swarm.LocalNodeState}}'")
  if [[ "$state" == inactive ]]; then
    # Token is streamed over SSH, never printed or placed in a local command argument.
    ssh_node daytick-1 'sudo docker swarm join-token -q manager' \
      | ssh_node "$node" "read -r token; sudo docker swarm join --token \"\$token\" --advertise-addr '${ips[$((n-1))]}' '${ips[0]}:2377'"
  elif [[ "$state" == active ]]; then
    other=$(ssh_node "$node" "sudo docker info --format '{{.Swarm.Cluster.ID}}'")
    [[ "$other" == "$cluster" ]] || fail "$node belongs to another Swarm; refusing to modify it."
  else fail "Unexpected Swarm state on $node: $state"; fi
done
# Refresh IDs after joins and validate the complete membership before labeling.
for n in 1 2 3; do
  node_ids[$((n-1))]=$(ssh_node "daytick-$n" "sudo docker info --format '{{.Swarm.NodeID}}'")
done
validate_members final
# Docker node names can be full GCE DNS hostnames. Always target verified IDs.
for n in 1 2 3; do ssh_node daytick-1 "sudo docker node update --label-add daytick.host=daytick-$n '${node_ids[$((n-1))]}' >/dev/null"; done
ssh_node daytick-1 "sudo /usr/local/sbin/daytick-check-postgres-mount && sudo docker node update --label-add daytick.db=true '${node_ids[0]}' >/dev/null"
CREATED+=(three-manager-swarm-and-labels)
if [[ -z "$TAG" ]]; then
  TAG=$(ssh_node daytick-1 "sudo cat '$remote/.release-tag' 2>/dev/null || true")
  TAG=${TAG:-"release-$(date -u +%Y%m%dT%H%M%SZ)"}
fi
[[ "$TAG" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,100}$ ]] || fail 'Invalid saved tag'
# Do not rebuild an existing release tag: mutable tags break reproducible rollback.
images=$(gc artifacts docker images list "australia-southeast1-docker.pkg.dev/$PROJECT_ID/daytick" --include-tags --format=json)
if python3 -c 'import json,sys; tag=sys.argv[1]; sys.exit(0 if any(t==tag or t.endswith(":"+tag) for x in json.load(sys.stdin) for t in x.get("tags",[])) else 1)' "$TAG" <<< "$images"; then
  echo "Reusing release $TAG; checking all five images. Use --tag=NEW_TAG for a code update."
  for service in auth task timer frontend gateway; do
    gc artifacts docker images describe "australia-southeast1-docker.pkg.dev/$PROJECT_ID/daytick/daytick-$service:$TAG" >/dev/null
  done
else
  ssh_node daytick-1 "cd '$remote'; sudo bash scripts/gcp-release.sh build '$PROJECT_ID' '$TAG'"
fi
ssh_node daytick-1 "cd '$remote'; sudo bash scripts/gcp-release.sh deploy '$PROJECT_ID' '$TAG'; sudo bash scripts/gcp-release.sh verify '$PROJECT_ID' '$TAG'"
CREATED+=(stack-deployed)
# Each node must report all its app/DB containers healthy; allow startup grace period.
for n in 1 2 3; do
  ssh_node "daytick-$n" 'sudo bash -s' <<'HEALTH'
set -eu
for attempt in $(seq 1 30); do
  ids=$(docker ps -q --filter label=com.docker.stack.namespace=daytick)
  if [[ -n "$ids" ]] && docker inspect $ids | python3 -c 'import json,sys; sys.exit(0 if all(c["State"].get("Health",{}).get("Status")=="healthy" for c in json.load(sys.stdin)) else 1)'; then exit 0; fi
  sleep 10
done
echo 'Container health verification timed out' >&2
exit 1
HEALTH
done
ssh_node daytick-1 "cd '$remote'; sudo python3 scripts/gcp-smoke.py"
echo "Deployment checks passed for release $TAG. Verify registration, tasks and countdown in the browser."
echo "Open a second Cloud Shell tab and run:"
echo "gcloud --project=$PROJECT_ID compute start-iap-tunnel daytick-1 8080 --zone=$ZONE --local-host-port=localhost:8080"
echo 'Then use Cloud Shell Web Preview on port 8080. Keep the tunnel open.'
echo "Back up $remote/.secrets on VM 1 securely. Do not commit it."
