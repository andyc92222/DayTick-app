import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from uuid import uuid4

import httpx
import psycopg
import pytest


def test_database_outage_returns_503(monkeypatch):
    from services.task.app.main import app
    from shared import runtime

    @contextmanager
    def failed_connection(service):
        raise psycopg.OperationalError("simulated database outage")
        yield  # pragma: no cover

    monkeypatch.setattr(runtime, "database", failed_connection)

    # No lifespan here: exercise readiness during an outage after successful startup.
    async def probe():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            assert (await client.get("/health/live")).status_code == 200
            assert (await client.get("/health/ready")).status_code == 503

    asyncio.run(probe())


def test_start_racing_completion_never_leaves_running_timer(client, urls, account, task_factory):
    user = account()
    task = task_factory(user)

    def start():
        return httpx.post(
            f"{urls['timer']}/api/timers/{task['id']}/start", headers=user["headers"], timeout=20
        )

    def complete():
        return httpx.post(
            f"{urls['task']}/api/tasks/{task['id']}/complete", headers=user["headers"], timeout=20
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        starting, completing = pool.submit(start), pool.submit(complete)
        assert starting.result().status_code in (200, 409)
        assert completing.result().status_code == 200
    assert client.get(f"{urls['timer']}/api/timers", headers=user["headers"]).json()["timers"] == []


def test_stale_internal_retry_is_fenced(client, urls, account, task_factory, service_processes):
    if not service_processes:
        pytest.skip("Only direct native endpoints can access internal APIs")
    from shared.runtime import setting

    user = account()
    task = task_factory(user)
    result = client.post(
        f"{urls['timer']}/internal/tasks/{task['id']}/synchronize",
        headers={"Authorization": f"Bearer {setting('INTERNAL_TOKEN')}"},
        json={
            "user_id": user["user"]["id"],
            "action": "duration",
            "operation_id": str(uuid4()),
            "duration": 500,
        },
    )
    assert result.status_code == 409
    state = client.get(f"{urls['timer']}/api/timers/{task['id']}", headers=user["headers"]).json()
    assert state["planned_duration_seconds"] == 60


def test_delete_active_task_removes_timer(client, urls, account, task_factory):
    user = account()
    task = task_factory(user)
    base = f"{urls['timer']}/api/timers/{task['id']}"
    assert client.post(base + "/start", headers=user["headers"]).status_code == 200
    assert client.delete(f"{urls['task']}/api/tasks/{task['id']}", headers=user["headers"]).status_code == 204
    assert client.get(base, headers=user["headers"]).status_code == 404
    assert client.get(f"{urls['timer']}/api/timers", headers=user["headers"]).json()["timers"] == []
