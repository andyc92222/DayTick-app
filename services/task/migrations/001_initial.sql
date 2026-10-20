CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    planned_duration_seconds INTEGER NOT NULL CHECK (planned_duration_seconds BETWEEN 1 AND 86400),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','updating','completing','deleting')),
    pending_duration_seconds INTEGER,
    operation_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS tasks_user_day ON tasks(user_id,created_at);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS operation_id UUID;
