import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest


def test_countdown_lifecycle(client, urls, account, task_factory):
    user = account()
    task = task_factory(user, 10)
    base = f"{urls['timer']}/api/timers/{task['id']}"
    assert client.get(base, headers=user["headers"]).json()["status"] == "idle"
    start = client.post(base + "/start", headers=user["headers"])
    assert start.status_code == 200, start.text
    assert start.json()["ends_at"] is not None
    time.sleep(0.15)
    paused = client.post(base + "/pause", headers=user["headers"]).json()
    assert paused["status"] == "paused"
    assert 0 < paused["remaining_seconds"] < 10
    time.sleep(0.15)
    assert (
        client.get(base, headers=user["headers"]).json()["remaining_seconds"] == paused["remaining_seconds"]
    )
    resumed = client.post(base + "/resume", headers=user["headers"])
    assert resumed.json()["status"] == "running"
    reset = client.post(base + "/reset", headers=user["headers"]).json()
    assert reset["status"] == "idle" and reset["remaining_seconds"] == 10


def test_expiry_is_not_completion(client, urls, account, task_factory):
    user = account()
    task = task_factory(user, 1)
    base = f"{urls['timer']}/api/timers/{task['id']}"
    assert client.post(base + "/start", headers=user["headers"]).status_code == 200
    time.sleep(1.1)
    expired = client.get(base, headers=user["headers"]).json()
    assert expired["status"] == "expired" and expired["remaining_seconds"] == 0
    assert (
        client.get(f"{urls['task']}/api/tasks/{task['id']}", headers=user["headers"]).json()["status"]
        == "active"
    )
    another = task_factory(user)
    assert (
        client.post(f"{urls['timer']}/api/timers/{another['id']}/start", headers=user["headers"]).status_code
        == 200
    )


def test_concurrent_starts_across_replicas(client, urls, account, task_factory):
    user = account()
    tasks = [task_factory(user, 120) for _ in range(8)]

    def start(item):
        index, task = item
        base = urls["timer_replica" if index % 2 else "timer"]
        return httpx.post(f"{base}/api/timers/{task['id']}/start", headers=user["headers"], timeout=20)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(start, enumerate(tasks)))
    assert sorted(result.status_code for result in results) == [200] + [409] * 7
    timers = client.get(f"{urls['timer']}/api/timers", headers=user["headers"]).json()["timers"]
    assert sum(t["status"] == "running" for t in timers) == 1
    # A different user has an independent running countdown.
    other = account()
    task = task_factory(other)
    assert (
        client.post(f"{urls['timer']}/api/timers/{task['id']}/start", headers=other["headers"]).status_code
        == 200
    )


def test_timer_ownership_and_internal_auth(client, urls, account, task_factory):
    owner, intruder = account(), account()
    task = task_factory(owner)
    base = f"{urls['timer']}/api/timers/{task['id']}"
    for suffix in ["", "/start", "/pause", "/resume", "/reset"]:
        result = client.request("POST" if suffix else "GET", base + suffix, headers=intruder["headers"])
        assert result.status_code == 404
    assert client.get(f"{urls['timer']}/api/timers", headers=intruder["headers"]).json()["timers"] == []
    assert client.post(base + "/start").status_code == 401
    result = client.post(
        f"{urls['timer']}/internal/tasks/{task['id']}/synchronize",
        headers=owner["headers"],
        json={"user_id": owner["user"]["id"], "action": "delete", "duration": 60},
    )
    # The gateway deliberately hides internal APIs; direct native requests authenticate them.
    assert result.status_code in (401, 404)


def test_duration_change_and_completion_stop_timer(client, urls, account, task_factory):
    user = account()
    task = task_factory(user)
    timer = f"{urls['timer']}/api/timers/{task['id']}"
    task_url = f"{urls['task']}/api/tasks/{task['id']}"
    client.post(timer + "/start", headers=user["headers"])
    assert (
        client.patch(task_url, headers=user["headers"], json={"planned_duration_seconds": 90}).status_code
        == 409
    )
    client.post(timer + "/reset", headers=user["headers"])
    assert (
        client.patch(task_url, headers=user["headers"], json={"planned_duration_seconds": 90}).status_code
        == 200
    )
    assert client.get(timer, headers=user["headers"]).json()["remaining_seconds"] == 90
    client.post(timer + "/start", headers=user["headers"])
    assert client.post(task_url + "/complete", headers=user["headers"]).status_code == 200
    assert client.get(f"{urls['timer']}/api/timers", headers=user["headers"]).json()["timers"] == []
    assert client.post(timer + "/start", headers=user["headers"]).status_code == 409


def test_restart_persistence_and_task_service_failure(client, urls, account, task_factory, service_processes):
    if not service_processes:
        pytest.skip("Process failure injection is only enabled for the native test harness")
    user = account()
    task = task_factory(user, 120)
    base = f"{urls['timer']}/api/timers/{task['id']}"
    started = client.post(base + "/start", headers=user["headers"]).json()
    service_processes.restart("timer")
    state = client.get(base, headers=user["headers"]).json()
    assert state["ends_at"] == started["ends_at"]
    assert state["remaining_seconds"] < started["remaining_seconds"]
    service_processes.stop("task")
    try:
        assert client.post(base + "/pause", headers=user["headers"]).status_code == 503
    finally:
        service_processes.start("task", 8002)
    paused = client.post(base + "/pause", headers=user["headers"]).json()
    service_processes.restart("timer")
    assert (
        client.get(base, headers=user["headers"]).json()["remaining_seconds"] == paused["remaining_seconds"]
    )


def test_retry_completion_after_timer_outage(client, urls, account, task_factory, service_processes):
    if not service_processes:
        pytest.skip("Requires native process control")
    user = account()
    task = task_factory(user)
    base = f"{urls['timer']}/api/timers/{task['id']}"
    task_url = f"{urls['task']}/api/tasks/{task['id']}"
    client.post(base + "/start", headers=user["headers"])
    service_processes.stop("timer")
    try:
        result = client.post(task_url + "/complete", headers=user["headers"])
        assert result.status_code == 503
        assert client.get(task_url, headers=user["headers"]).json()["status"] == "completing"
        replica = f"{urls['timer_replica']}/api/timers/{task['id']}/start"
        assert client.post(replica, headers=user["headers"]).status_code == 409
    finally:
        service_processes.start("timer", 8003)
    assert client.post(task_url + "/complete", headers=user["headers"]).json()["status"] == "completed"
    assert client.get(f"{urls['timer']}/api/timers", headers=user["headers"]).json()["timers"] == []
