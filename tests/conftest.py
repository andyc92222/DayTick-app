import os
from uuid import uuid4

import httpx
import pytest

from scripts.native import Services, environment


@pytest.fixture(scope="session")
def service_processes():
    if os.getenv("DAYTICK_TEST_NATIVE") != "1":
        yield None
        return
    processes = Services()
    try:
        for name, port in [("auth", 8001), ("task", 8002), ("timer", 8003), ("timer_replica", 8004)]:
            processes.start(name, port)
        yield processes
    finally:
        processes.close()


@pytest.fixture(scope="session")
def urls(service_processes):
    base = os.getenv("DAYTICK_API_URL")
    if base:
        return {name: base.rstrip("/") for name in ["auth", "task", "timer", "timer_replica"]}
    if service_processes:
        return {
            name: f"http://127.0.0.1:{port}"
            for name, port in [("auth", 8001), ("task", 8002), ("timer", 8003), ("timer_replica", 8004)]
        }
    pytest.skip("Set DAYTICK_TEST_NATIVE=1 with local PostgreSQL, or DAYTICK_API_URL for a running stack")


@pytest.fixture
def client(urls):
    with httpx.Client(timeout=20) as value:
        yield value


@pytest.fixture
def account(client, urls):
    def create():
        body = {"email": f"test-{uuid4().hex}@example.com", "password": "Testing-daytick-123!"}
        result = client.post(f"{urls['auth']}/api/auth/register", json=body)
        assert result.status_code == 201, result.text
        session = result.json()
        return {
            **session,
            "credentials": body,
            "headers": {"Authorization": f"Bearer {session['access_token']}"},
        }

    return create


@pytest.fixture
def task_factory(client, urls):
    def create(user, duration=60, title="A test task"):
        result = client.post(
            f"{urls['task']}/api/tasks",
            headers=user["headers"],
            json={"title": title, "planned_duration_seconds": duration},
        )
        assert result.status_code == 201, result.text
        return result.json()

    return create


@pytest.fixture(scope="session", autouse=True)
def local_environment():
    # Only configure this Python process for explicitly requested native tests.
    if os.getenv("DAYTICK_TEST_NATIVE") == "1":
        original = os.environ.copy()
        os.environ.update(environment())
        yield
        os.environ.clear()
        os.environ.update(original)
    else:
        yield
