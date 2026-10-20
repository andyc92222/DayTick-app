# DayTick

DayTick is a personal daily countdown planner: register, keep private tasks, and start, pause, resume or reset a countdown. Tasks and timers survive refreshes and restarts. Built with React, three FastAPI services, PostgreSQL and Nginx.

## Prerequisites

- **Local:** Git, Node.js 24, and Docker Desktop (Linux containers) or Docker Engine with Compose v2. Python and npm package installation are not needed for the Docker setup.
- **Google Cloud:** a project with billing enabled and sufficient quota, Google Cloud Shell, and permissions to manage Compute Engine, networks/firewalls, service accounts, API enablement and Artifact Registry. You also need IAP tunnel access, SSH/sudo access and permission to use the VM service account. See [deployment details](docs/DEPLOYMENT.md).



## Deploy to Google Cloud

Create or select a project, enable billing, then open **Cloud Shell** and clone the repository as above. Use the **Project ID**, not the display name (for example, a project named DayClick may have a different ID).
Open the Cloud shell
```bash
bash scripts/setup-gcp.sh --project-id=YOUR_PROJECT_ID
bash scripts/setup-swarm.sh --project-id=YOUR_PROJECT_ID
```

The first command creates or checks the Sydney infrastructure: three Ubuntu VMs, networking, image registry and persistent database disk. The second mounts the disk safely, configures three Swarm managers, builds images on VM 1 and deploys DayTick. Both ask you to confirm the project. A new empty database disk also requires typing `FORMAT daytick-postgres`; existing data is never intentionally reformatted. Initial installation/builds can take several minutes.

### Access the Deployed Application

After successfully running the two deployment scripts, access DayTick through a local Google Cloud IAP tunnel.

**Prerequisites:** Install [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) on your computer and ensure your Google account has permission to access the project's VM through IAP.

**1. Authenticate with Google Cloud**

Open PowerShell (Windows) or a local terminal and run:

```bash
gcloud auth login
```

**2. Start the IAP tunnel**

Replace `YOUR_PROJECT_ID` with your own Google Cloud Project ID:

```bash
gcloud --project=YOUR_PROJECT_ID compute start-iap-tunnel daytick-1 8080 --zone=australia-southeast1-b --local-host-port=localhost:8080
```

**3. Open DayTick**

Keep the terminal running and open:

http://localhost:8080

You can now register, log in, manage tasks and use countdown timers.

**Why use a local IAP tunnel?**

Cloud Shell Web Preview may redirect API requests through Google's authentication service (`ssh.cloud.google.com`). These redirects can be blocked by the application's Content Security Policy (CSP), resulting in a "Cannot reach DayTick" error.

Using a local IAP tunnel avoids the Cloud Shell Web Preview proxy and forwards requests securely from `localhost:8080` to the deployed VM.

**Note:** `localhost:8080` is accessible only on the computer running the tunnel. Other users, including tutors, must establish their own authorized IAP tunnel to access the application from their computers. No public website URL is required.

## Stop or clean up

Stop all three VMs without deleting their boot disks, Swarm state or database:

```bash
gcloud --project=YOUR_PROJECT_ID compute instances stop daytick-1 daytick-2 daytick-3 --zone=australia-southeast1-b
# Start them again, then rerun setup-swarm.sh to verify/redeploy and refresh registry access.
gcloud --project=YOUR_PROJECT_ID compute instances start daytick-1 daytick-2 daytick-3 --zone=australia-southeast1-b
```

For final removal, follow the [ordered cleanup checklist](docs/DEPLOYMENT.md#cleanup-after-marking). Deleting VMs alone **retains the PostgreSQL data disk and registry**. Deleting those resources removes data/images permanently; back up first.

## AI usage declaration

I developed DayTick collaboratively with generative AI assistance. I supplied the assignment requirements, defined the app's scope and features, and participated in design decisions, including retaining the three-VM Google Cloud architecture and prioritising deployment reliability. I also ran deployment attempts and supplied error reports to guide troubleshooting. AI assistance contributed substantially to code, tests and documentation; this submission is not represented as entirely independently written code.

The prompts below are summaries of the instructions used across iterative conversations, rather than verbatim transcripts.

| AI/MT tool | Purpose of use | Prompts used (summarised) | Where used |
| --- | --- | --- | --- |
| OpenAI Codex (AI coding assistant) | Plan and implement the application from my requirements, including the dashboard, microservices, authentication, persisted timers and container setup. | “Build DayTick using React, TypeScript, FastAPI, PostgreSQL, Nginx, Docker Compose and Swarm”; “Implement the complete specification incrementally and test locally without adding unnecessary features.” | `frontend/`, `services/`, `shared/`, `infrastructure/`, `compose.yml`, dependency/configuration files and supporting scripts. |
| OpenAI Codex | Diagnose and repair Windows dependency installation and native PostgreSQL startup problems while preserving existing data. | “Investigate npm EPERM errors and the missing embedded-postgres package; repair the local setup safely without deleting my database.” | Native development scripts under `scripts/`, local setup tests and development instructions in `docs/DEVELOPMENT.md`. |
| OpenAI Codex | Review cloud architecture and costs; prepare portable deployment automation and troubleshoot errors reported during my deployment attempts. | “Review the original three-VM deployment and recommend low-cost resources”; “Prevent PostgreSQL starting without its data disk”; “Create project-independent setup scripts”; “Fix the release-directory permission error”; “Support GCE hostnames and resume a partially initialized Swarm without resetting it.” | `scripts/setup-gcp.sh`, `scripts/setup-swarm.sh`, related `scripts/gcp-*` helpers, `infrastructure/swarm/`, `docs/DEPLOYMENT.md` and deployment regression tests. |
| OpenAI Codex | Generate and revise tests, run available local checks, and help document setup, validation results and submission contents. | “Test authentication, task ownership, CRUD, countdown lifecycle, concurrency and persistence”; “Add regression tests for deployment failures”; “Make the README concise and beginner-friendly”; “Identify files to include or exclude from the submission”; “Add an AI declaration acknowledging my participation in app design.” | `tests/`, frontend tests, `.github/workflows/ci.yml`, `README.md`, `TESTING.md`, `docs/DEVELOPMENT.md` and this declaration. |
| OpenAI image generation tool (accessed through the imagegen skill) | Produce a simple visual explanation of the cloud architecture. | “Generate a simple architecture image showing how DayTick works in the cloud and save it in docs.” The expanded image prompt specified the React browser, Nginx, Auth/Task/Timer services, PostgreSQL, persistent disk and three Swarm VMs. | `docs/daytick-architecture.png`. |

No machine translation tool use is recorded in these development conversations. AI-generated suggestions and local test results do not establish that every Google Cloud deployment or recovery scenario has been verified; the deployment documentation identifies the remaining validation limits.
