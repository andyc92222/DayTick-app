"""Run native dev services (optional alternative to Docker). No system services installed."""

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def environment():
    env = os.environ.copy()
    env.update(
        {
            "DB_HOST": "127.0.0.1",
            "DB_PORT": env.get("LOCAL_DB_PORT", "55432"),
            "DB_NAME": "daytick",
            "APP_TIMEZONE": "Australia/Brisbane",
            "TASK_URL": "http://127.0.0.1:8002",
            "TIMER_URL": "http://127.0.0.1:8003",
        }
    )
    for name in [
        "JWT_PUBLIC_KEY",
        "JWT_PRIVATE_KEY",
        "INTERNAL_TOKEN",
        "AUTH_DB_PASSWORD",
        "TASK_DB_PASSWORD",
        "TIMER_DB_PASSWORD",
    ]:
        env[f"{name}_FILE"] = str(ROOT / ".secrets" / name.lower().replace("_key", ""))
    return env


class Services:
    def __init__(self):
        self.processes = {}
        self.logs = []

    def start(self, name, port):
        (ROOT / ".local").mkdir(exist_ok=True)
        log = open(ROOT / ".local" / f"{name}-{port}.log", "a", encoding="utf-8")
        self.logs.append(log)
        module = "timer" if name == "timer_replica" else name
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                f"services.{module}.app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            cwd=ROOT,
            env=environment(),
            stdout=log,
            stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        self.processes[name] = (process, port)
        import httpx

        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError(f"{name} failed to start. See .local/{name}-{port}.log")
            try:
                if httpx.get(f"http://127.0.0.1:{port}/health/ready", timeout=1).status_code == 200:
                    return
            except httpx.RequestError:
                pass
            time.sleep(0.1)
        raise RuntimeError(f"{name} startup timeout")

    def stop(self, name):
        process, _ = self.processes[name]
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()

    def restart(self, name):
        port = self.processes[name][1]
        self.stop(name)
        self.start(name, port)

    def close(self):
        for name in self.processes:
            if self.processes[name][0].poll() is None:
                self.stop(name)
        for log in self.logs:
            log.close()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", action="store_true", help="Serve the built frontend on port 4173")
    args = parser.parse_args()
    services = Services()
    vite = None
    try:
        for name, port in [("auth", 8001), ("task", 8002), ("timer", 8003)]:
            services.start(name, port)
        vite = subprocess.Popen(
            [
                shutil.which("npm.cmd" if os.name == "nt" else "npm"),
                "run",
                "preview" if args.preview else "dev",
            ],
            cwd=ROOT / "frontend",
        )
        port = 4173 if args.preview else 5173
        print(f"DayTick ready at http://127.0.0.1:{port}. Ctrl+C stops the services.", flush=True)
        vite.wait()
    except KeyboardInterrupt:
        pass
    finally:
        if vite and vite.poll() is None:
            # npm has children on Windows. Use taskkill only for this process tree.
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(vite.pid), "/T", "/F"], capture_output=True)
            else:
                vite.terminate()
        services.close()
