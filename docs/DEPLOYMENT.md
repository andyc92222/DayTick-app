# Google Cloud deployment

**Prepared and locally tested; not deployed or verified on Google Cloud.** Use Bash in Google Cloud Shell. Do not run these scripts on a production project. No cloud resources are created merely by cloning the repository.

## Architecture and cost

- Region `australia-southeast1` (Sydney), zone `australia-southeast1-b`.
- Three Ubuntu 24.04 `e2-standard-2` VMs: 2 vCPUs / 8 GiB each; all are Swarm managers and run containers.
- Each VM has a 20 GiB `pd-standard` boot disk. VM 1 also has a retained 20 GiB `pd-balanced` PostgreSQL disk with device name `daytick-postgres`.
- Two replicas each of Auth, Task, Timer, frontend and Nginx; one PostgreSQL instance on VM 1. Replicas use the existing soft host spread preference and Swarm VIP/ingress routing.
- Custom VPC/subnet (`10.42.0.0/24`); cluster ports only between tagged nodes. IAP range `35.235.240.0/20` can reach SSH and port 8080. No public application ingress, GKE, NAT or Google load balancer is created.
- Three ephemeral external IPv4 addresses provide outbound package/image access. They have running-time charges. No static external IP is reserved. Internal addresses remain with the stopped VMs; deleting/recreating a VM is a separate recovery operation.
- Regional Artifact Registry Docker repository `daytick`; allow roughly 2 GiB initially for current and rollback images, then measure actual usage. Old release tags are retained until explicitly removed.

VM 1/PostgreSQL and the single zone are single points of failure. Three managers tolerate one manager failure, not two. This setup provides persistence and app replica recovery, not automatic PostgreSQL failover. No architecture changes are made by the setup scripts.

## Preparation and permissions

Create/select a project and enable billing in the console. Use its **Project ID**, not its display name. No personal project/account is hardcoded. In Cloud Shell, clone the repository and run from its root. Cloud Shell supplies `gcloud`, Python 3, Bash and tar. Docker Engine/Buildx/Compose are installed on the VMs by the existing startup script; all image builds run on VM 1. No Docker daemon, Node or npm install is needed in Cloud Shell.

The operator needs permission to enable services, view billing status, administer Compute instances/disks/networks/firewalls, create/use service accounts, and manage Artifact Registry repositories/IAM. Typical roles include Service Usage Admin, Compute Admin, Service Account Admin, Service Account User and Artifact Registry Admin, plus billing visibility and IAP-secured Tunnel User. Use your institution's IAM process; the scripts do not grant operator privileges. Organization policies, OS Login (including OS Admin Login for sudo), SSH key restrictions, IAP policies, service-account restrictions or quota rules may require an administrator. The scripts verify project access and billing; individual API operations enforce permissions and stop on denial. A full effective-IAM preflight is not claimed.

The node service account `daytick-nodes@PROJECT_ID.iam.gserviceaccount.com` receives **repository-scoped** Artifact Registry Writer because VM 1 builds/pushes; nodes use the same account to pull. No service-account keys are generated. Attached nodes have the `cloud-platform` scope, with actual access limited by IAM.

```bash
bash scripts/setup-gcp.sh --project-id=YOUR_PROJECT_ID
bash scripts/setup-swarm.sh --project-id=YOUR_PROJECT_ID
```

Both scripts display the actual project name/ID and require typing the ID before making changes. Every `gcloud` call explicitly selects that project; the active gcloud configuration is not changed. The first script enables Compute, Artifact Registry, IAM and IAP APIs, reports regional quotas and checks available CPU/IP quota where exposed. Quotas are not zonal capacity reservations; disk, project-wide or policy constraints can still reject creation. Billing visibility is required: inability to verify billing stops setup.

## Infrastructure reruns and partial failures

`setup-gcp.sh` creates resources in dependency order and reuses existing same-name resources only when relevant settings match. It checks subnet/firewall rules, registry format, VM size/network/identity/scopes, Ubuntu boot disk size/type, and PostgreSQL disk size/type/attachment. It never deletes or automatically replaces conflicting resources. Stopped VMs must be started explicitly. Resources use fixed DayTick names; do not reuse these names for unrelated workloads. No existing broad network firewall or organization policy audit is performed.

On an error, scripts stop and report completed milestones without rolling back or deleting resources. Inspect the named project in the console before rerunning. A cloud operation may have succeeded just before a connection failed, so the console remains the authoritative inventory. IAM propagation may require waiting and rerunning. If Docker installation failed, inspect:

```bash
gcloud --project=YOUR_PROJECT_ID compute ssh daytick-1 --zone=australia-southeast1-b --tunnel-through-iap --command='sudo journalctl -u google-startup-scripts.service --no-pager -n 100'
```

The startup script installs Docker only when absent. Subsequent boots start the existing version without upgrading or restarting an already-running daemon. An incomplete Docker installation requires explicit repair; setup does not upgrade it automatically.

## Disk safety, secrets and release deployment

`setup-swarm.sh` waits for Docker on all three nodes and uploads only allowlisted source directories to `/opt/daytick-PROJECT_ID` on VM 1. Local `.env`, `.secrets`, database files and npm dependencies are not copied. Use a trusted, reviewed checkout.

For a new disk, you must type **FORMAT daytick-postgres**. The remote helper refuses partitioned, mounted or signature-bearing disks and reads the entire disk to verify it contains only zero bytes before formatting. An unrecognized disk with nonzero data is never formatted, even after confirmation. An existing ext4 disk is mounted without formatting. Conflicting fstab entries, an incorrect mount, or files hidden beneath an unmounted directory cause a stop for manual investigation.

The helper records a UUID-based fstab entry, installs and verifies the existing PostgreSQL mount guard, and restarts Docker on the first guard installation before initializing Swarm. On later runs it verifies the guard without intentionally restarting a healthy daemon. Docker on VM 1 cannot start without the recorded disk mounted at `/srv/daytick/postgres`. PostgreSQL's `pgdata` subdirectory avoids ext4 `lost+found`. Do not remove the guard to work around mount failures.

VMs join as three managers using internal IPs. Foreign clusters, unexpected nodes, drained nodes or a database label on another host are refused. Host labels support spreading app replicas; only VM 1 receives `daytick.db=true`, after guard verification. Swarm join tokens are streamed over IAP SSH and are not printed by the setup script. Do not enable shell tracing (`bash -x`) when deploying.

VM 1 builds/pushes with `scripts/build-push.sh`, then deploys with `scripts/deploy-swarm.sh`. Root-only secret files are created on VM 1 and existing ones are preserved. When a database or Swarm secrets already exist, missing secret files cause a stop: **restore the originals from a secure backup**, rather than generating incompatible database passwords. Back up `/opt/daytick-PROJECT_ID/.secrets` securely off-host. Never commit it or post its contents in screenshots. The default cloud timezone is `Australia/Brisbane`; local `.env` is not sourced. To change cloud timezone, edit the release helper's default deliberately before deployment.

The first run creates a timestamp release tag. Successful deployments save it on VM 1; reruns reuse it rather than silently rebuild changed source. To deploy changed code:

```bash
bash scripts/setup-swarm.sh --project-id=YOUR_PROJECT_ID --tag=assignment-v2
```

Use a new tag per release. Existing tags are reused only if all five images exist. A partially pushed release requires a new tag (or deliberate registry repair); setup will not silently overwrite a published tag. Old images are retained for rollback. Builds on the 20 GiB boot disk can eventually exhaust space: review `sudo docker system df` before further releases and remove unused build cache deliberately with `sudo docker builder prune`. Avoid pruning rollback images immediately before presentation.

Registry authentication uses a short-lived access token from the VM's attached service account, refreshed before deployment. Swarm receives it through `--with-registry-auth`. Tokens expire; rerun setup-swarm before a later demonstration, image update or rescheduling requiring pulls. Cached images normally permit restart, but a one-time token is not permanent unattended recovery. No background credential-renewal service is installed. See [Google's registry authentication documentation](https://cloud.google.com/artifact-registry/docs/docker/authentication).

## Access and verification

```bash
gcloud --project=YOUR_PROJECT_ID compute start-iap-tunnel daytick-1 8080 --zone=australia-southeast1-b --local-host-port=localhost:8080
```

Keep the tunnel open, then use Cloud Shell Web Preview on port 8080. From another workstation with gcloud/IAP permissions, open `http://localhost:8080` on that workstation. Do not register a domain or buy a public load balancer for the private demonstration.

Setup checks three manager memberships, desired/running replicas, all running containers' health, gateway and frontend responses, then runs an API smoke test through Nginx. Smoke tests leave two unique disposable user accounts; their tasks are removed. These checks do not prove cloud failure recovery, rolling update or rollback. Record actual commands and results for the assignment:

- Register two users and check private task lists/CRUD, countdown controls and Time Up.
- Refresh during a countdown and after a container replacement; verify preserved state.
- Test simultaneous starts through replicas and ownership isolation using the existing API suite.
- Drain a non-database node and verify app rescheduling; restore availability afterward.
- Deploy a new tag, watch rolling updates, and rehearse rollback with compatible migrations.
- Stop/restart the cluster and verify retained tasks, disk mounting, node reconnection and application health.

On VM 1 (`gcloud compute ssh ... --tunnel-through-iap`), use:

```bash
sudo docker node ls
sudo docker stack services daytick
sudo docker stack ps daytick --no-trunc
sudo docker service logs --tail=50 daytick_timer
# Changes below affect the running application; capture evidence before/after.
sudo docker service update --force daytick_timer
sudo docker node update --availability drain daytick-3
sudo docker node update --availability active daytick-3
sudo docker service rollback daytick_timer
```

After rollback, retain the intended release tag in your deployment record. The next setup run deploys the saved tag, which could restore a bad release unless you explicitly select the previous known-good `--tag`. Database migrations/data are not rolled back by Swarm.

## Stop, restart and backup

```bash
gcloud --project=YOUR_PROJECT_ID compute instances stop daytick-1 daytick-2 daytick-3 --zone=australia-southeast1-b
gcloud --project=YOUR_PROJECT_ID compute instances start daytick-1 daytick-2 daytick-3 --zone=australia-southeast1-b
bash scripts/setup-swarm.sh --project-id=YOUR_PROJECT_ID
```

While stopped, VM CPU/RAM charges stop, but all boot/data disks, registry images and any backups/snapshots remain billable. Ephemeral external IPv4 addresses are released on stop; Swarm uses retained internal addresses. Do not recreate VMs to resume a demonstration. All three stopped managers leave no quorum; after startup a majority must return before scheduling can resume. The disk guard can intentionally prevent VM 1's Docker startup on a mount problem. Inspect the disk/fstab and Docker journal instead of bypassing it. No bespoke application shutdown hook is installed; PostgreSQL relies on Docker/OS termination and its crash recovery. Take a backup before stopping for important marking sessions.

On VM 1, make a protected logical backup (contains credentials/data):

```bash
umask 077
DB_CONTAINER=$(sudo docker ps --filter label=com.docker.swarm.service.name=daytick_postgres --format '{{.ID}}')
test -n "$DB_CONTAINER"
sudo docker exec "$DB_CONTAINER" pg_dumpall -U postgres > "daytick-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

Store an encrypted copy and matching secrets off-host and rehearse restoration separately. If VM 1 is lost, fence it first, attach the retained disk to a replacement in the same zone, restore matching secrets and mount/verify the existing filesystem **without formatting**. Install the guard before assigning the DB label; remove that label from the old node. Never start two PostgreSQL instances against the same disk. Such replacement recovery is manual, not performed by the two setup scripts.

## Cleanup after marking

Stopping VMs is reversible; final deletion is destructive. Review the project and resource inventory in the console first. The setup scripts do not perform cleanup automatically. Do not run the following until marking is complete and backups are safe. Substitute your Project ID in every command; keep gcloud's deletion confirmations enabled.

```bash
# Deletes VMs and their auto-delete boot disks (including Swarm state and staged secrets).
# The PostgreSQL disk is explicitly retained by setup-gcp.
gcloud --project=YOUR_PROJECT_ID compute instances delete daytick-1 daytick-2 daytick-3 --zone=australia-southeast1-b
# PERMANENTLY deletes PostgreSQL data. Only after backup/marking and explicit review:
gcloud --project=YOUR_PROJECT_ID compute disks delete daytick-postgres --zone=australia-southeast1-b
# PERMANENTLY deletes all DayTick release/rollback images:
gcloud --project=YOUR_PROJECT_ID artifacts repositories delete daytick --location=australia-southeast1
# Remaining dedicated networking and identity resources (ensure nothing else uses them):
gcloud --project=YOUR_PROJECT_ID compute firewall-rules delete daytick-iap daytick-swarm-internal
gcloud --project=YOUR_PROJECT_ID compute networks subnets delete daytick-subnet --region=australia-southeast1
gcloud --project=YOUR_PROJECT_ID compute networks delete daytick-vpc
gcloud --project=YOUR_PROJECT_ID iam service-accounts delete daytick-nodes@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

Review disks, snapshots/backups, addresses, VM instances and registry storage in the console afterward; remove any deliberately retained or manually created resources separately. Do not delete an entire shared university project, remove unrelated IAM grants or disable APIs used by other work. The scripts do not create static IPs, NAT, load balancers, buckets or snapshots.

## Local validation limits

`npm run test:config` covers Bash syntax, project/billing confirmation, explicit project scoping, permission-denied resource lookups, disk initialization refusal, repeated Docker startup and UUID mount guards using command stubs. These are local regression checks, not real GCE/systemd tests. Ruff and Python compilation check the stdlib-only deployment smoke script. Docker and gcloud were unavailable in the implementation environment; image builds, Compose startup, live API smoke checks, IAM propagation, IAP tunneling and cloud restart/recovery have not been executed here. Run and record those checks in the selected project before claiming deployment success.
