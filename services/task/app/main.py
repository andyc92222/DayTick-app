from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import httpx
from fastapi import Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from shared.runtime import (
    application,
    current_user,
    database,
    internal_auth,
    now,
    setting,
    timezone_name,
    user_lock,
)

app = application("task", Path(__file__).parents[1] / "migrations/001_initial.sql")


def mutation_lock(user_id: str = Depends(current_user)):
    # Distinct from Timer's lock. Serialize mutations across task replicas without
    # keeping task rows locked while Timer calls back over HTTP.
    with database("task") as connection:
        user_lock(connection, f"task:{user_id}")
        yield


class TaskCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=200)
    planned_duration_seconds: int = Field(ge=1, le=86400, strict=True)


class TaskEdit(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    planned_duration_seconds: int | None = Field(default=None, ge=1, le=86400, strict=True)


def owned(connection, task_id, user_id):
    task = connection.execute(
        "SELECT * FROM tasks WHERE id=%s AND user_id=%s FOR UPDATE", (task_id, user_id)
    ).fetchone()
    if not task:
        raise HTTPException(404, "Task not found")
    return task


def day_bounds(at: datetime, zone: str):
    tz = ZoneInfo(zone)
    day = at.astimezone(tz).date()
    return (
        datetime.combine(day, time.min, tz).astimezone(timezone.utc),
        datetime.combine(day + timedelta(days=1), time.min, tz).astimezone(timezone.utc),
    )


@app.get("/api/tasks/today")
def today(user_id: str = Depends(current_user)):
    start, end = day_bounds(now(), timezone_name())
    with database("task") as connection:
        tasks = connection.execute(
            "SELECT * FROM tasks WHERE user_id=%s AND created_at >= %s AND created_at < %s "
            "ORDER BY created_at,id",
            (user_id, start, end),
        ).fetchall()
    return {"tasks": tasks, "timezone": timezone_name(), "server_time": now()}


@app.post("/api/tasks", status_code=201, dependencies=[Depends(mutation_lock)])
def create(body: TaskCreate, user_id: str = Depends(current_user)):
    with database("task") as connection:
        return connection.execute(
            "INSERT INTO tasks(id,user_id,title,planned_duration_seconds) VALUES (%s,%s,%s,%s) RETURNING *",
            (uuid4(), user_id, body.title, body.planned_duration_seconds),
        ).fetchone()


@app.get("/api/tasks/{task_id}")
def get_task(task_id: UUID, user_id: str = Depends(current_user)):
    with database("task") as connection:
        return owned(connection, task_id, user_id)


@app.get("/internal/tasks/{task_id}", dependencies=[Depends(internal_auth)])
def pending_task(task_id: UUID):
    with database("task") as connection:
        task = connection.execute("SELECT * FROM tasks WHERE id=%s", (task_id,)).fetchone()
        if not task:
            raise HTTPException(404, "Task not found")
        return task


def synchronize(task, action: str):
    try:
        result = httpx.post(
            f"{setting('TIMER_URL', 'http://timer:8000')}/internal/tasks/{task['id']}/synchronize",
            headers={"Authorization": f"Bearer {setting('INTERNAL_TOKEN')}"},
            json={
                "user_id": str(task["user_id"]),
                "action": action,
                "operation_id": str(task["operation_id"]),
                "duration": task["pending_duration_seconds"] or task["planned_duration_seconds"],
            },
            timeout=8,
        )
    except httpx.RequestError:
        raise HTTPException(503, "Timer service unavailable. Retry this operation to finish safely.")
    if result.status_code == 409:
        raise HTTPException(409, "Reset the timer before changing its duration")
    if result.status_code != 200:
        raise HTTPException(503, "Timer synchronization failed. Retry this operation.")


@app.patch("/api/tasks/{task_id}", dependencies=[Depends(mutation_lock)])
def edit(task_id: UUID, body: TaskEdit, user_id: str = Depends(current_user)):
    with database("task") as connection:
        task = owned(connection, task_id, user_id)
        if task["status"] not in ("active", "updating"):
            raise HTTPException(409, "Task cannot be edited in its current state")
        duration = body.planned_duration_seconds
        if task["status"] == "updating" and duration != task["pending_duration_seconds"]:
            raise HTTPException(409, "Retry the pending duration change first")
        needs_sync = task["status"] == "updating" or (
            duration is not None and duration != task["planned_duration_seconds"]
        )
        task = connection.execute(
            "UPDATE tasks SET title=COALESCE(%s,title), status=%s, pending_duration_seconds=%s, "
            "operation_id=%s, updated_at=clock_timestamp() WHERE id=%s RETURNING *",
            (
                body.title,
                "updating" if needs_sync else "active",
                duration if needs_sync else None,
                task["operation_id"] if task["status"] == "updating" else uuid4(),
                task_id,
            ),
        ).fetchone()
    if needs_sync:
        try:
            synchronize(task, "duration")
        except HTTPException as exc:
            if exc.status_code == 409:
                with database("task") as connection:
                    connection.execute(
                        "UPDATE tasks SET status='active',pending_duration_seconds=NULL "
                        "WHERE id=%s AND status='updating'",
                        (task_id,),
                    )
            raise
        with database("task") as connection:
            task = connection.execute(
                "UPDATE tasks SET planned_duration_seconds=pending_duration_seconds, "
                "pending_duration_seconds=NULL,status='active',updated_at=clock_timestamp() "
                "WHERE id=%s AND status='updating' RETURNING *",
                (task_id,),
            ).fetchone()
            if not task:
                return owned(connection, task_id, user_id)
    return task


def finish(task_id, user_id, action):
    pending = "completing" if action == "complete" else "deleting"
    with database("task") as connection:
        task = owned(connection, task_id, user_id)
        if action == "complete" and task["status"] == "completed":
            return task
        if task["status"] not in ("active", "completed", pending):
            raise HTTPException(409, "Finish the pending task operation first")
        task = connection.execute(
            "UPDATE tasks SET status=%s,operation_id=%s,updated_at=clock_timestamp() WHERE id=%s RETURNING *",
            (pending, task["operation_id"] if task["status"] == pending else uuid4(), task_id),
        ).fetchone()
    synchronize(task, action)
    with database("task") as connection:
        if action == "delete":
            connection.execute("DELETE FROM tasks WHERE id=%s AND status='deleting'", (task_id,))
            return Response(status_code=204)
        task = connection.execute(
            "UPDATE tasks SET status='completed',updated_at=clock_timestamp() "
            "WHERE id=%s AND status='completing' RETURNING *",
            (task_id,),
        ).fetchone()
        return task or owned(connection, task_id, user_id)


@app.post("/api/tasks/{task_id}/complete", dependencies=[Depends(mutation_lock)])
def complete(task_id: UUID, user_id: str = Depends(current_user)):
    return finish(task_id, user_id, "complete")


@app.delete("/api/tasks/{task_id}", status_code=204, dependencies=[Depends(mutation_lock)])
def delete(task_id: UUID, user_id: str = Depends(current_user)):
    return finish(task_id, user_id, "delete")
