#!/bin/bash
# Run in Google Cloud Shell from the checkout. No default project is assumed.
source "$(dirname -- "${BASH_SOURCE[0]}")/gcp-common.sh"
parse_args "$@"
[[ -z "$TAG" ]] || fail '--tag belongs to setup-swarm.sh only.'
confirm_project
gc services enable compute.googleapis.com artifactregistry.googleapis.com iam.googleapis.com iap.googleapis.com
CREATED+=(APIs-enabled)
echo 'Regional quotas (need up to 6 E2 vCPUs, 3 in-use IPs, 60 GiB standard + 20 GiB balanced disk):'
gc compute regions describe "$REGION" --format='table(quotas.metric,quotas.usage,quotas.limit)'
# Quotas are not capacity reservations. Also account for already existing DayTick VMs.
instances=$(gc compute instances list --filter="zone:($ZONE) AND name~'^daytick-[123]$'" --format=json)
needed=$(python3 -c 'import json,sys; print(3-len(json.load(sys.stdin)))' <<< "$instances")
gc compute regions describe "$REGION" --format=json | python3 -c '
import json,sys
d=json.load(sys.stdin); n=int(sys.argv[1]); q={x["metric"]:x for x in d.get("quotas",[])}
for metric,extra in [("CPUS",n*2),("E2_CPUS",n*2),("IN_USE_ADDRESSES",n)]:
 if metric in q and q[metric]["limit"]-q[metric]["usage"]<extra:
  sys.exit("Insufficient regional quota: "+metric+". Request quota or free resources before continuing.")
' "$needed"
if ! exists compute networks list --filter='name=daytick-vpc'; then
  gc compute networks create daytick-vpc --subnet-mode=custom
  CREATED+=(daytick-vpc)
fi
gc compute networks describe daytick-vpc --format=json | check_json 'not d.get("autoCreateSubnetworks", False)' 'daytick-vpc must be a custom-mode VPC'
if ! exists compute networks subnets list --filter="name=daytick-subnet AND region:($REGION)"; then
  gc compute networks subnets create daytick-subnet --network=daytick-vpc --range=10.42.0.0/24 --region="$REGION"
  CREATED+=(daytick-subnet)
fi
gc compute networks subnets describe daytick-subnet --region="$REGION" --format=json | check_json 'd["network"].endswith("/daytick-vpc") and d["ipCidrRange"]=="10.42.0.0/24"' 'Existing subnet differs; refusing to modify it'
if ! exists compute firewall-rules list --filter='name=daytick-swarm-internal'; then
  gc compute firewall-rules create daytick-swarm-internal --network=daytick-vpc --source-tags=daytick-swarm --target-tags=daytick-swarm --allow=tcp:2377,tcp:7946,udp:7946,udp:4789,esp
  CREATED+=(daytick-swarm-internal)
fi
if ! exists compute firewall-rules list --filter='name=daytick-iap'; then
  gc compute firewall-rules create daytick-iap --network=daytick-vpc --source-ranges=35.235.240.0/20 --target-tags=daytick-swarm --allow=tcp:22,tcp:8080
  CREATED+=(daytick-iap)
fi
# Existing same-name firewall rules must match, including no extra public ranges/ports.
for rule in daytick-swarm-internal daytick-iap; do
  gc compute firewall-rules describe "$rule" --format=json | python3 -c '
import json,sys
d=json.load(sys.stdin); internal=sys.argv[1].endswith("internal")
actual={(x["IPProtocol"],p) for x in d.get("allowed",[]) for p in x.get("ports",["*"])}
expected={("tcp","2377"),("tcp","7946"),("udp","7946"),("udp","4789"),("esp","*")} if internal else {("tcp","22"),("tcp","8080")}
assert d["network"].endswith("/daytick-vpc") and d.get("direction")=="INGRESS" and not d.get("disabled",False)
assert set(d.get("targetTags",[]))=={"daytick-swarm"} and actual==expected, "Existing firewall ports/tags differ"
assert set(d.get("sourceTags",[]))==({"daytick-swarm"} if internal else set())
assert set(d.get("sourceRanges",[]))==(set() if internal else {"35.235.240.0/20"}), "Existing firewall source ranges differ"
assert not d.get("sourceServiceAccounts") and not d.get("targetServiceAccounts")
' "$rule"
done
if ! exists artifacts repositories list --location="$REGION" --filter="name=projects/$PROJECT_ID/locations/$REGION/repositories/daytick"; then
  gc artifacts repositories create daytick --repository-format=docker --location="$REGION"
  CREATED+=(artifact-repository-daytick)
fi
gc artifacts repositories describe daytick --location="$REGION" --format=json | check_json 'd["format"]=="DOCKER"' 'Existing registry is not Docker format'
SA="daytick-nodes@$PROJECT_ID.iam.gserviceaccount.com"
if ! exists iam service-accounts list --filter="email=$SA"; then
  gc iam service-accounts create daytick-nodes --display-name='DayTick Swarm nodes'
  CREATED+=(daytick-nodes-service-account)
fi
# Repository-scoped writer: VM 1 builds/pushes, all nodes pull. No account key files.
gc artifacts repositories add-iam-policy-binding daytick --location="$REGION" --member="serviceAccount:$SA" --role=roles/artifactregistry.writer --condition=None >/dev/null
if ! exists compute disks list --filter="name=daytick-postgres AND zone:($ZONE)"; then
  gc compute disks create daytick-postgres --zone="$ZONE" --size=20GB --type=pd-balanced --labels=app=daytick
  CREATED+=(daytick-postgres-disk)
fi
gc compute disks describe daytick-postgres --zone="$ZONE" --format=json | check_json 'int(d["sizeGb"])==20 and d["type"].endswith("/pd-balanced")' 'Existing PostgreSQL disk differs'
for n in 1 2 3; do
  node="daytick-$n"
  if ! exists compute instances list --filter="name=$node AND zone:($ZONE)"; then
    gc compute instances create "$node" --zone="$ZONE" --machine-type=e2-standard-2 \
      --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
      --boot-disk-size=20GB --boot-disk-type=pd-standard \
      --network=daytick-vpc --subnet=daytick-subnet --tags=daytick-swarm \
      --service-account="$SA" --scopes=cloud-platform --labels=app=daytick \
      --metadata-from-file=startup-script=infrastructure/swarm/gce-startup.sh
    CREATED+=("$node")
  fi
  gc compute instances describe "$node" --zone="$ZONE" --format=json | python3 -c '
import json,sys
d=json.load(sys.stdin); sa=sys.argv[1]
assert d["machineType"].endswith("/e2-standard-2")
assert d["networkInterfaces"][0]["subnetwork"].endswith("/daytick-subnet")
assert "daytick-swarm" in d.get("tags",{}).get("items",[])
assert any(x["email"]==sa and "https://www.googleapis.com/auth/cloud-platform" in x.get("scopes",[]) for x in d.get("serviceAccounts",[])), "Existing VM identity/scopes differ"
assert d["status"]=="RUNNING", "Existing VM is stopped; start it explicitly and rerun"
' "$SA"
  boot=$(gc compute instances describe "$node" --zone="$ZONE" --format='value(disks[0].source)')
  gc compute disks describe "${boot##*/}" --zone="$ZONE" --format=json | check_json 'int(d["sizeGb"])==20 and d["type"].endswith("/pd-standard") and "/ubuntu-os-cloud/" in d.get("sourceImage", "") and "2404" in d.get("sourceImage", "")' 'Existing boot disk differs; expected Ubuntu 24.04 on 20 GiB pd-standard'
done
users=$(gc compute disks describe daytick-postgres --zone="$ZONE" --format='value(users)')
if [[ -z "$users" ]]; then
  gc compute instances attach-disk daytick-1 --zone="$ZONE" --disk=daytick-postgres --device-name=daytick-postgres
  CREATED+=(postgres-disk-attached)
else
  [[ "$users" == */instances/daytick-1 ]] || fail 'PostgreSQL disk attached elsewhere; refusing to move it.'
fi
gc compute instances describe daytick-1 --zone="$ZONE" --format=json | check_json 'any(x.get("deviceName")=="daytick-postgres" and x["source"].endswith("/daytick-postgres") for x in d["disks"])' 'Existing data disk device name differs'
gc compute instances set-disk-auto-delete daytick-1 --zone="$ZONE" --disk=daytick-postgres --no-auto-delete
echo "Infrastructure ready. Next: bash scripts/setup-swarm.sh --project-id=$PROJECT_ID"
