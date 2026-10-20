"""Small stdlib-only check through Nginx; never prints credentials or tokens."""

import json
import secrets
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4


def request(method, path, token=None, body=None, expected=200):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    req = Request("http://127.0.0.1:8080" + path, data, headers, method=method)
    try:
        response = urlopen(req, timeout=30)
    except HTTPError as exc:
        response = exc
    with response:
        status = response.code
        payload = response.read()
    if expected is not None and status != expected:
        raise RuntimeError(f"{method} {path}: expected {expected}, got {status}")
    return status, json.loads(payload) if payload else None


def main():
    tokens = []
    for _ in range(2):
        credentials = {"email": f"smoke-{uuid4().hex}@example.com", "password": secrets.token_hex(24)}
        request("POST", "/api/auth/register", body=credentials, expected=201)
        _, login = request("POST", "/api/auth/login", body=credentials)
        tokens.append(login["access_token"])
    owner, other = tokens
    request("GET", "/api/tasks/today", expected=401)
    tasks = []
    try:
        for _ in range(2):
            _, task = request(
                "POST",
                "/api/tasks",
                owner,
                {"title": "Deployment smoke test", "planned_duration_seconds": 120},
                201,
            )
            tasks.append(task["id"])
        task_path = f"/api/tasks/{tasks[0]}"
        request("GET", task_path, other, expected=404)
        request("POST", f"/api/timers/{tasks[0]}/start", other, expected=404)
        request("PATCH", task_path, owner, {"title": "Deployment smoke checked"})
        request("GET", "/api/tasks/today", owner)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(
                pool.map(
                    lambda task: request("POST", f"/api/timers/{task}/start", owner, expected=None),
                    tasks,
                )
            )
        if sorted(status for status, _ in results) != [200, 409]:
            raise RuntimeError("Concurrent starts did not yield exactly one success and one conflict")
        winner = tasks[next(i for i, (status, _) in enumerate(results) if status == 200)]
        timer_path = f"/api/timers/{winner}"
        _, initial = request("GET", timer_path, owner)
        _, refreshed = request("GET", timer_path, owner)
        if initial["ends_at"] != refreshed["ends_at"]:
            raise RuntimeError("Saved countdown deadline changed between reads")
        for action, state in [("pause", "paused"), ("resume", "running"), ("reset", "idle")]:
            _, timer = request("POST", timer_path + "/" + action, owner)
            if timer["status"] != state:
                raise RuntimeError(f"Incorrect timer state after {action}")
        request("POST", f"/api/tasks/{winner}/complete", owner)
    finally:
        for task in tasks:
            request("DELETE", f"/api/tasks/{task}", owner, expected=204)
    print("API smoke passed: auth, ownership, CRUD, concurrent timer starts and saved deadline.")


if __name__ == "__main__":
    main()
