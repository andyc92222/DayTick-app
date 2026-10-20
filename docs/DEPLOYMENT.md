# Google Cloud deployment runbook

These commands are a deployment plan, not evidence of a verified cloud deployment. Run Bash commands from Cloud Shell or a machine with `gcloud`, Docker, Git, and Node 24. Replace the placeholders first. Creating VMs, disks, Artifact Registry, and a load balancer incurs charges; this repository does not create them automatically.

## 1. Project, registry, and network

```sh
# Authenticate to your own project and choose an immutable application release tag.
gcloud auth login
export PROJECT=YOUR_PROJECT_ID
export REGION=australia-southeast1
export ZONE=australia-southeast1-b
export TAG=v1
export REGISTRY="$REGION-docker.pkg.dev/$PROJECT/daytick"
gcloud config set project "$PROJECT"
gcloud services enable compute.googleapis.com artifactregistry.googleapis.com

# Create a private image repository and authorize your local Docker client.
gcloud artifacts repositories create daytick --repository-format=docker --location="$REGION"
gcloud auth configure-docker "$REGION-docker.pkg.dev"

# Run from the checked-out repository root; builds and pushes all five app images.
sh scripts/build-push.sh

# Isolate the cluster's traffic from other VMs.
gcloud compute networks create daytick-vpc --subnet-mode=custom
gcloud compute networks subnets create daytick-subnet --network=daytick-vpc \
  --range=10.42.0.0/24 --region="$REGION"

# Swarm management, node discovery, overlay traffic, and ESP for encrypted overlays.
# Only nodes carrying the cluster tag can originate this traffic.
gcloud compute firewall-rules create daytick-swarm-internal --network=daytick-vpc \
  --source-tags=daytick-swarm --target-tags=daytick-swarm \
  --allow=tcp:2377,tcp:7946,udp:7946,udp:4789,esp

# SSH and the initial application preview are available through IAP only.
gcloud compute firewall-rules create daytick-iap --network=daytick-vpc \
  --source-ranges=35.235.240.0/20 --target-tags=daytick-swarm --allow=tcp:22,tcp:8080

# Nodes can read application images using their attached service account.
gcloud iam service-accounts create daytick-nodes --display-name='DayTick Swarm nodes'
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:daytick-nodes@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/artifactregistry.reader
```

Your operator identity also needs Compute administration, IAP tunneling, permission to use the node service account, and Artifact Registry write access. Grant these through your project's IAM process. Do not place account keys in this repository.

## 2. Create nodes and persistent storage

```sh
# Three managers retain quorum if one manager fails. All also run app workloads.
# The startup script installs Docker Engine/Compose on Ubuntu 24.04.
gcloud compute instances create daytick-1 daytick-2 daytick-3 \
  --zone="$ZONE" --machine-type=e2-standard-2 \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --network=daytick-vpc --subnet=daytick-subnet --tags=daytick-swarm \
  --service-account="daytick-nodes@$PROJECT.iam.gserviceaccount.com" --scopes=cloud-platform \
  --metadata-from-file=startup-script=infrastructure/swarm/gce-startup.sh

# Separate persistent data disk; retain it independently of the VM boot disk.
gcloud compute disks create daytick-postgres --zone="$ZONE" --size=20GB --type=pd-balanced
gcloud compute instances attach-disk daytick-1 --zone="$ZONE" \
  --disk=daytick-postgres --device-name=daytick-postgres
gcloud compute instances set-disk-auto-delete daytick-1 --zone="$ZONE" \
  --disk=daytick-postgres --no-auto-delete

# Enter each node over IAP after startup has finished installing Docker.
gcloud compute ssh daytick-1 --zone="$ZONE" --tunnel-through-iap
```

On **daytick-1**, format the **new empty** disk and mount it. For recovery of an existing disk, skip formatting entirely. Check `lsblk -f` and the device identity before executing `mkfs`.

```sh
lsblk -f
# Fresh, empty data disk only:
sudo mkfs.ext4 -m 0 /dev/disk/by-id/google-daytick-postgres
sudo mkdir -p /srv/daytick/postgres
sudo mount /dev/disk/by-id/google-daytick-postgres /srv/daytick/postgres
# Persist the mount; use the UUID reported by blkid in /etc/fstab.
sudo blkid /dev/disk/by-id/google-daytick-postgres
# Add: UUID=REPORTED_UUID /srv/daytick/postgres ext4 defaults 0 2
# Then verify the entry before rebooting:
sudo mount -a
sudo docker version
```

The disk's mount root can contain `lost+found`. PostgreSQL needs an empty data directory, so create a subdirectory and use it as `PGDATA` in both stack and recovery instructions (the supplied stack sets `PGDATA=/var/lib/postgresql/data/pgdata`). Do not deploy PostgreSQL unless the intended disk is mounted; otherwise it could initialize on the VM's boot disk.

## 3. Initialize Swarm

On **daytick-1**, replace `10.42.0.X` with its internal IP:

```sh
sudo docker swarm init --advertise-addr 10.42.0.X
# Get the manager join command. Treat its join token as a credential.
sudo docker swarm join-token manager
```

Connect to daytick-2 and daytick-3 using `gcloud compute ssh ... --tunnel-through-iap` and run the printed manager join command on each. Join tokens should not be committed or included in screenshots.

On daytick-1:

```sh
sudo docker node ls
# Exactly one node must carry this label; the database will not migrate to arbitrary hosts.
sudo docker node update --label-add daytick.db=true daytick-1
```

For larger deployments use dedicated managers and multiple workers; retain an odd manager quorum. The supplied small deployment spreads replicas across available nodes using a placement preference.

## 4. Install release files, credentials, and deploy

From your deployment workstation/Cloud Shell:

```sh
# Use a clean release checkout. Setup preserves existing secrets when rerun.
node scripts/setup.mjs
gcloud compute ssh daytick-1 --zone="$ZONE" --tunnel-through-iap --command='mkdir -p ~/daytick'
gcloud compute scp --recurse --zone="$ZONE" --tunnel-through-iap \
  .secrets infrastructure scripts daytick-1:~/daytick/

# Send a short-lived registry credential over SSH stdin, without displaying it.
gcloud auth print-access-token | gcloud compute ssh daytick-1 --zone="$ZONE" --tunnel-through-iap \
  --command="sudo docker login -u oauth2accesstoken --password-stdin https://$REGION-docker.pkg.dev"
gcloud compute ssh daytick-1 --zone="$ZONE" --tunnel-through-iap
```

On **daytick-1**, from `~/daytick`:

```sh
cd ~/daytick
# Restrict the staged files; keep a secure off-host copy for disaster recovery.
chmod 700 .secrets
chmod 600 .secrets/*
export REGISTRY=australia-southeast1-docker.pkg.dev/YOUR_PROJECT_ID/daytick
export TAG=v1
export APP_TIMEZONE=Australia/Brisbane
# Preserve REGISTRY/TAG when using sudo. External Swarm secrets are installed once.
sudo --preserve-env=REGISTRY,TAG,APP_TIMEZONE sh scripts/deploy-swarm.sh

# Wait until every desired replica is running and healthy.
sudo docker stack services daytick
sudo docker stack ps daytick --no-trunc
sudo docker service logs --tail=50 daytick_task
```

Swarm secrets are encrypted in the manager's Raft store and mounted only into services that need them. The application uses versioned secret names. The deploy script does not overwrite existing secrets. Keep database passwords consistent with an existing PostgreSQL disk; replacing a secret file alone does not rotate a database role's password. New secret/config versions require updating their external names in the stack.

Artifact Registry access tokens are short-lived. Refresh the manager's login and redeploy with `--with-registry-auth` before later updates/scaling that may pull images on new nodes. For unattended recovery, arrange periodic credential renewal through your deployment automation using the attached service account and update each service with `docker service update --with-registry-auth SERVICE`. Do not assume a one-time login provides permanent registry access.

## 5. Preview privately, then expose HTTPS if required

From Cloud Shell/workstation:

```sh
# Private preview over an authenticated encrypted IAP tunnel.
gcloud compute start-iap-tunnel daytick-1 8080 --zone="$ZONE" --local-host-port=localhost:8080
# Open localhost:8080 on the machine running the tunnel (Cloud Shell supports Web Preview).
```

For public use, terminate HTTPS at a Google global external Application Load Balancer in front of Swarm's port 8080. Leave backend ports private. The following commands use a Google-managed certificate for a domain you control:

```sh
export DOMAIN=daytick.YOUR_DOMAIN
# Allow Google's proxy/health-check ranges, without opening 8080 to the public internet.
gcloud compute firewall-rules create daytick-lb --network=daytick-vpc \
  --source-ranges=35.191.0.0/16,130.211.0.0/22 --target-tags=daytick-swarm --allow=tcp:8080
gcloud compute instance-groups unmanaged create daytick-group --zone="$ZONE"
gcloud compute instance-groups unmanaged add-instances daytick-group --zone="$ZONE" \
  --instances=daytick-1,daytick-2,daytick-3
gcloud compute instance-groups unmanaged set-named-ports daytick-group --zone="$ZONE" --named-ports=http:8080
gcloud compute health-checks create http daytick-health --port=8080 --request-path=/health/live
gcloud compute backend-services create daytick-backend --global --load-balancing-scheme=EXTERNAL_MANAGED \
  --protocol=HTTP --port-name=http --health-checks=daytick-health
gcloud compute backend-services add-backend daytick-backend --global \
  --instance-group=daytick-group --instance-group-zone="$ZONE"
gcloud compute url-maps create daytick-map --default-service=daytick-backend
gcloud compute addresses create daytick-ip --global --ip-version=IPV4 --network-tier=PREMIUM
gcloud compute ssl-certificates create daytick-cert --domains="$DOMAIN" --global
gcloud compute target-https-proxies create daytick-https --url-map=daytick-map --ssl-certificates=daytick-cert
gcloud compute forwarding-rules create daytick-https-rule --global --load-balancing-scheme=EXTERNAL_MANAGED \
  --network-tier=PREMIUM --address=daytick-ip --target-https-proxy=daytick-https --ports=443
gcloud compute addresses describe daytick-ip --global --format='value(address)'
# Set DOMAIN's DNS A record to that address, then wait for the certificate to become ACTIVE.
gcloud compute ssl-certificates describe daytick-cert --global
```

Use `https://$DOMAIN` after the certificate is active. No HTTP public forwarding rule is created. Gateway health confirms gateway availability; perform the API/browser smoke tests below to check the application and dependencies.

## 6. Verify cloud behavior explicitly

Record the release tag, node list, desired/running replicas, commands, and results. Do not mark a check passed without running it:

- Register two users, create tasks, confirm ownership isolation and CRUD.
- Run the API suite with `DAYTICK_API_URL=https://your-domain` and browser suite with `DAYTICK_E2E_URL=https://your-domain` from a release checkout with test tooling installed. Native process-control tests will be skipped explicitly.
- Start one task, refresh the browser, pause/resume/reset, and confirm expiry displays Time Up without completing it.
- Send concurrent starts and confirm exactly one running countdown per user.
- Force a Timer service replacement and confirm its saved deadline/paused remainder survives.
- Scale Task/Timer to three replicas, check routing across nodes, and rerun concurrency tests.
- Exercise an application update and rollback, including a deliberately unhealthy test image in an isolated staging stack.
- Reboot the database node and verify the data disk mounts before PostgreSQL starts and data is retained. This single database has a recovery interval.
- Drain a non-database node and verify application rescheduling; restore it afterward.

```sh
# Run on a manager; these operations affect the deployed application.
sudo docker service scale daytick_task=3 daytick_timer=3
sudo docker service update --force daytick_timer
sudo docker node update --availability drain daytick-3
# After checking rescheduling:
sudo docker node update --availability active daytick-3

# Build/push a new immutable TAG on your build machine, refresh registry login,
# then deploy that TAG with scripts/deploy-swarm.sh. Watch the rolling update.
sudo docker service inspect daytick_timer --format '{{json .UpdateStatus}}'

# Restore the previous service configuration after a bad release.
sudo docker service rollback daytick_timer
sudo docker service ps daytick_timer --no-trunc
```

Update the deployment record and intended TAG after a rollback so the next deployment does not restore the bad image. Automatic rollback responds to unhealthy/failed updates; semantic regressions still need smoke tests and manual rollback. Keep migrations backward-compatible with the previous application version.

## 7. Backup and database-node recovery

The database has persistent storage, not automatic HA. On the labeled database node:

```sh
# Take a logical backup including roles, schemas, and data; protect the output.
umask 077
DB_CONTAINER=$(sudo docker ps --filter label=com.docker.swarm.service.name=daytick_postgres --format '{{.ID}}')
test -n "$DB_CONTAINER"
sudo docker exec "$DB_CONTAINER" pg_dumpall -U postgres > "daytick-$(date -u +%Y%m%dT%H%M%SZ).sql"
# Store encrypted backups off-host and rehearse restoration in a disposable cluster.
```

If the database VM is lost, stop/fence it first. Detach and reattach the retained disk to a replacement VM in the same zone, mount the existing filesystem at `/srv/daytick/postgres` **without formatting**, remove the database label from the old node, label only the replacement, and allow Swarm to recreate PostgreSQL there. Never run two PostgreSQL instances against the same disk. For disk loss, restore an off-host backup to a new empty database. Keep role passwords and application secrets consistent with the backup.

App container restarts do not reset countdowns. A database outage produces readiness/API `503` responses until PostgreSQL returns; running timers continue to elapse by their saved absolute deadlines. Disk and manager quorum recovery remain operational responsibilities.

## Sources

- [Docker Ubuntu installation](https://docs.docker.com/engine/install/ubuntu/)
- [Swarm deployment](https://docs.docker.com/engine/swarm/stack-deploy/), [routing mesh](https://docs.docker.com/engine/swarm/ingress/), [updates and rollback](https://docs.docker.com/engine/swarm/services/)
- [Compute Engine instances](https://cloud.google.com/compute/docs/instances/create-start-instance)
- [Artifact Registry Docker authentication](https://cloud.google.com/artifact-registry/docs/docker/authentication)
- [External Application Load Balancer setup](https://cloud.google.com/load-balancing/docs/https/setup-global-ext-https-compute)
