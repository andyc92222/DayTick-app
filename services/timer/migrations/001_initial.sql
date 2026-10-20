CREATE TABLE IF NOT EXISTS timer_sessions (
    id UUID PRIMARY KEY,
    task_id UUID NOT NULL UNIQUE,
    user_id UUID NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('idle','running','paused','expired')),
    planned_duration_seconds INTEGER NOT NULL CHECK (planned_duration_seconds BETWEEN 1 AND 86400),
    remaining_seconds DOUBLE PRECISION NOT NULL CHECK (remaining_seconds >= 0),
    ends_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK ((status='running') = (ends_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_running_timer_per_user ON timer_sessions(user_id) WHERE status='running';
CREATE INDEX IF NOT EXISTS timers_user ON timer_sessions(user_id);
