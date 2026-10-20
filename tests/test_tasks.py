from datetime import datetime, timezone

import psycopg
import pytest

from services.task.app.main import day_bounds


def test_daily_boundaries_handle_timezone_and_dst():
    start, end = day_bounds(datetime(2026, 10, 18, 15, tzinfo=timezone.utc), "Australia/Brisbane")
    assert start.isoformat() == "2026-10-18T14:00:00+00:00"
    assert (end - start).total_seconds() == 86400
    start, end = day_bounds(datetime(2026, 10, 4, 5, tzinfo=timezone.utc), "Australia/Sydney")
    assert (end - start).total_seconds() == 23 * 3600


def test_crud_completion_and_ownership(client, urls, account, task_factory):
    alice, bob = account(), account()
    task = task_factory(alice)
    url = f"{urls['task']}/api/tasks/{task['id']}"
    for method, suffix, body in [
        ("GET", "", None),
        ("PATCH", "", {"title": "Intrusion"}),
        ("DELETE", "", None),
        ("POST", "/complete", None),
    ]:
        result = client.request(method, url + suffix, headers=bob["headers"], json=body)
        assert result.status_code == 404
    assert client.get(f"{urls['task']}/api/tasks/today", headers=bob["headers"]).json()["tasks"] == []
    edited = client.patch(
        url, headers=alice["headers"], json={"title": "Revised", "planned_duration_seconds": 90}
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["planned_duration_seconds"] == 90
    tasks = client.get(f"{urls['task']}/api/tasks/today", headers=alice["headers"]).json()["tasks"]
    assert [t["id"] for t in tasks] == [task["id"]]
    completed = client.post(url + "/complete", headers=alice["headers"])
    assert completed.json()["status"] == "completed"
    assert client.post(url + "/complete", headers=alice["headers"]).status_code == 200
    assert client.delete(url, headers=alice["headers"]).status_code == 204
    assert client.get(url, headers=alice["headers"]).status_code == 404


def test_task_input_cannot_spoof_owner(client, urls, account):
    user = account()
    base = f"{urls['task']}/api/tasks"
    for body in [
        {"title": " ", "planned_duration_seconds": 60},
        {"title": "Test", "planned_duration_seconds": 0},
        {"title": "Test", "planned_duration_seconds": 60, "user_id": user["user"]["id"]},
    ]:
        assert client.post(base, headers=user["headers"], json=body).status_code == 422
    assert client.get(base + "/today").status_code == 401


def test_today_excludes_previous_day(client, urls, account, task_factory, service_processes):
    if not service_processes:
        pytest.skip("Requires direct native test database access")
    from shared.runtime import database

    user = account()
    old = task_factory(user)
    current = task_factory(user)
    with database("task") as connection:
        connection.execute(
            "UPDATE tasks SET created_at=clock_timestamp()-interval '2 days' WHERE id=%s", (old["id"],)
        )
    tasks = client.get(f"{urls['task']}/api/tasks/today", headers=user["headers"]).json()["tasks"]
    assert [task["id"] for task in tasks] == [current["id"]]


def test_database_roles_are_isolated(service_processes):
    if not service_processes:
        pytest.skip("Requires native test role credentials")
    from shared.runtime import database

    for role, other in [("auth", "task.tasks"), ("task", "auth.users"), ("timer", "task.tasks")]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with database(role) as connection:
                connection.execute(f"SELECT * FROM {other}")
