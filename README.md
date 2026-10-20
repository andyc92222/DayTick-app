# DayTick

DayTick is a personal daily countdown planner: register, keep private tasks, and start, pause, resume or reset a countdown. Tasks and timers survive refreshes and restarts. Built with React, three FastAPI services, PostgreSQL and Nginx.

## Prerequisites

- **Local:** Git, Node.js 24, and Docker Desktop (Linux containers) or Docker Engine with Compose v2. Python and npm package installation are not needed for the Docker setup.
- **Google Cloud:** a project with billing enabled and sufficient quota, Google Cloud Shell, and permissions to manage Compute Engine, networks/firewalls, service accounts, API enablement and Artifact Registry. You also need IAP tunnel access, SSH/sudo access and permission to use the VM service account. See [deployment details](docs/DEPLOYMENT.md).

## Run locally

Clone this repository using its GitHub **Code → HTTPS** URL, then enter the checkout:

```sh
git clone YOUR_REPOSITORY_HTTPS_URL daytick
cd daytick
node scripts/setup.mjs
```

Setup creates `.env` and random credentials in `.secrets/`, preserving existing files. Use `.env.example` as the configuration reference; edit `.env` if needed (default timezone: `Australia/Brisbane`). Keep secrets alongside your database and never commit them.

```sh
docker compose config --quiet
docker compose up --build --wait --wait-timeout 240
```

Open **http://localhost:8080** and register an account. If you changed `HTTP_PORT` in `.env`, use that port.

```sh
# Stop containers; preserve database data.
docker compose down
```

Do not use `down -v` unless you intend to delete the local database. For native Windows development, API details and testing, see [the development guide](docs/DEVELOPMENT.md).

## Deploy to Google Cloud

Create or select a project, enable billing, then open **Cloud Shell** and clone the repository as above. Use the **Project ID**, not the display name (for example, a project named DayClick may have a different ID).

```bash
bash scripts/setup-gcp.sh --project-id=YOUR_PROJECT_ID
bash scripts/setup-swarm.sh --project-id=YOUR_PROJECT_ID
```

The first command creates or checks the Sydney infrastructure: three Ubuntu VMs, networking, image registry and persistent database disk. The second mounts the disk safely, configures three Swarm managers, builds images on VM 1 and deploys DayTick. Both ask you to confirm the project. A new empty database disk also requires typing `FORMAT daytick-postgres`; existing data is never intentionally reformatted. Initial installation/builds can take several minutes.

Open a second Cloud Shell tab:

```bash
gcloud --project=YOUR_PROJECT_ID compute start-iap-tunnel daytick-1 8080 --zone=australia-southeast1-b --local-host-port=localhost:8080
```

Keep the tunnel running and use **Cloud Shell → Web Preview → port 8080**. Application traffic is private through IAP; there is no public load balancer.

Cloud resources cost money. Stop VMs between demonstrations; disks and stored images still incur charges. These scripts are locally validated but **have not been deployed or verified on Google Cloud**. Read [deployment, recovery and cleanup instructions](docs/DEPLOYMENT.md) before running them.

## Stop or clean up

Stop all three VMs without deleting their boot disks, Swarm state or database:

```bash
gcloud --project=YOUR_PROJECT_ID compute instances stop daytick-1 daytick-2 daytick-3 --zone=australia-southeast1-b
# Start them again, then rerun setup-swarm.sh to verify/redeploy and refresh registry access.
gcloud --project=YOUR_PROJECT_ID compute instances start daytick-1 daytick-2 daytick-3 --zone=australia-southeast1-b
```

For final removal, follow the [ordered cleanup checklist](docs/DEPLOYMENT.md#cleanup-after-marking). Deleting VMs alone **retains the PostgreSQL data disk and registry**. Deleting those resources removes data/images permanently; back up first.
