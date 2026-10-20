from datetime import timedelta
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid4

import httpx
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field

from shared.runtime import (
    application,
    bearer,
    current_user,
    database,
    internal_auth,
    setting,
    user_lock,
)

app = application("timer", Path(__file__).parents[1] / "migrations/001_initial.sql")


def reconcile(connection, user_id):
    connection.execute(
        "UPDATE timer_sessions SET status='expired',remaining_seconds=0,ends_at=NULL,"
        "updated_at=clock_timestamp() WHERE user_id=%s AND status='running' AND ends_at<=clock_timestamp()",
        (user_id,),
    )


def snapshot(timer, server_time):
    if timer["status"] == "running":
        remaining = max(0, (timer["ends_at"] - server_time).total_seconds())
    else:
        remaining = timer["remaining_seconds"]
    return {**timer, "remaining_seconds": remaining, "server_time": server_time}


def task_for(task_id, credentials):
    try:
        result = httpx.get(
            f"{setting('TASK_URL', 'http://task:8000')}/api/tasks/{task_id}",
            headers={"Authorization": f"Bearer {credentials.credentials}"},
            timeout=5,
        )
    except httpx.RequestError:
        raise HTTPException(503, "Task service unavailable")
    if result.status_code in (401, 404):
        raise HTTPException(result.status_code, "Task not available")
    if result.status_code != 200:
        raise HTTPException(503, "Task service unavailable")
    return result.json()


@app.get("/api/timers")
def list_timers(user_id: str = Depends(current_user)):
    with database("timer") as connection:
        user_lock(connection, user_id)
        reconcile(connection, user_id)
        at = connection.execute("SELECT clock_timestamp() AS now").fetchone()["now"]
        timers = connection.execute("SELECT * FROM timer_sessions WHERE user_id=%s", (user_id,)).fetchall()
        return {"timers": [snapshot(timer, at) for timer in timers], "server_time": at}


@app.get("/api/timers/{task_id}")
def get_timer(
    task_id: UUID,
    user_id: str = Depends(current_user),
    credentials: HTTPAuthorizationCredentials = Depends(bearer),
):
    with database("timer") as connection:
        user_lock(connection, user_id)
        task = task_for(task_id, credentials)
        reconcile(connection, user_id)
        timer = connection.execute(
            "SELECT * FROM timer_sessions WHERE task_id=%s AND user_id=%s", (task_id, user_id)
        ).fetchone()
        at = connection.execute("SELECT clock_timestamp() AS now").fetchone()["now"]
        if not timer:
            timer = {
                "task_id": task_id,
                "status": "idle",
                "planned_duration_seconds": task["planned_duration_seconds"],
                "remaining_seconds": task["planned_duration_seconds"],
                "ends_at": None,
            }
        return snapshot(timer, at)


@app.post("/api/timers/{task_id}/{action}")
def transition(
    task_id: UUID,
    action: Literal["start", "pause", "resume", "reset"],
    user_id: str = Depends(current_user),
    credentials: HTTPAuthorizationCredentials = Depends(bearer),
):
    with database("timer") as connection:
        user_lock(connection, user_id)
        task = task_for(task_id, credentials)
        if task["status"] != "active":
            raise HTTPException(409, "Task is completed or has a pending change")
        reconcile(connection, user_id)
        connection.execute(
            "INSERT INTO timer_sessions(id,task_id,user_id,status,"
            "planned_duration_seconds,remaining_seconds) "
            "VALUES (%s,%s,%s,'idle',%s,%s) ON CONFLICT(task_id) DO NOTHING",
            (uuid4(), task_id, user_id, task["planned_duration_seconds"], task["planned_duration_seconds"]),
        )
        timer = connection.execute(
            "SELECT * FROM timer_sessions WHERE task_id=%s AND user_id=%s FOR UPDATE", (task_id, user_id)
        ).fetchone()
        if not timer:
            raise HTTPException(404, "Timer not found")
        at = connection.execute("SELECT clock_timestamp() AS now").fetchone()["now"]
        status = timer["status"]
        remaining = snapshot(timer, at)["remaining_seconds"]
        ends_at = timer["ends_at"]
        if action in ("start", "resume"):
            if status == "running":
                return snapshot(timer, at)  # duplicate requests are harmless
            expected = "idle" if action == "start" else "paused"
            if status != expected:
                raise HTTPException(409, f"Cannot {action} a {status} timer")
            running = connection.execute(
                "SELECT task_id FROM timer_sessions WHERE user_id=%s AND status='running'", (user_id,)
            ).fetchone()
            if running:
                raise HTTPException(409, "Pause or reset your running timer first")
            status, ends_at = "running", at + timedelta(seconds=remaining)
        elif action == "pause":
            if status not in ("running", "paused"):
                raise HTTPException(409, f"Cannot pause a {status} timer")
            status, ends_at = "paused", None
        else:
            status, ends_at, remaining = "idle", None, task["planned_duration_seconds"]
        timer = connection.execute(
            "UPDATE timer_sessions SET status=%s,ends_at=%s,remaining_seconds=%s,"
            "planned_duration_seconds=%s,updated_at=clock_timestamp() WHERE task_id=%s RETURNING *",
            (status, ends_at, remaining, task["planned_duration_seconds"], task_id),
        ).fetchone()
        return snapshot(timer, at)


class Synchronize(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: UUID
    action: Literal["duration", "complete", "delete"]
    operation_id: UUID
    duration: int = Field(ge=1, le=86400)


@app.post("/internal/tasks/{task_id}/synchronize", dependencies=[Depends(internal_auth)])
def synchronize(task_id: UUID, body: Synchronize):
    with database("timer") as connection:
        user_lock(connection, str(body.user_id))
        # Fence delayed HTTP retries after a newer task mutation. Task has already
        # committed its pending state and holds no task row locks here.
        try:
            result = httpx.get(
                f"{setting('TASK_URL', 'http://task:8000')}/internal/tasks/{task_id}",
                headers={"Authorization": f"Bearer {setting('INTERNAL_TOKEN')}"},
                timeout=5,
            )
        except httpx.RequestError:
            raise HTTPException(503, "Task service unavailable")
        if result.status_code != 200:
            raise HTTPException(503, "Cannot verify pending task mutation")
        task = result.json()
        expected = {"duration": "updating", "complete": "completing", "delete": "deleting"}[body.action]
        if (
            task["operation_id"] != str(body.operation_id)
            or task["status"] != expected
            or task["user_id"] != str(body.user_id)
        ):
            raise HTTPException(409, "Task mutation is no longer current")
        if body.action == "duration" and task["pending_duration_seconds"] != body.duration:
            raise HTTPException(409, "Duration mutation is no longer current")
        reconcile(connection, body.user_id)
        timer = connection.execute(
            "SELECT * FROM timer_sessions WHERE task_id=%s AND user_id=%s FOR UPDATE", (task_id, body.user_id)
        ).fetchone()
        if body.action == "duration":
            if timer and timer["status"] != "idle":
                raise HTTPException(409, "Reset the timer first")
            connection.execute(
                "UPDATE timer_sessions SET planned_duration_seconds=%s,remaining_seconds=%s,"
                "updated_at=clock_timestamp() WHERE task_id=%s AND user_id=%s",
                (body.duration, body.duration, task_id, body.user_id),
            )
        else:
            connection.execute(
                "DELETE FROM timer_sessions WHERE task_id=%s AND user_id=%s", (task_id, body.user_id)
            )
    return {"status": "synchronized"}
