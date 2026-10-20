#!/bin/sh
set -eu
# Only runs on a fresh PostgreSQL volume. Credentials are Docker secrets.
export AUTH_PASSWORD="$(cat /run/secrets/auth_db_password)"
export TASK_PASSWORD="$(cat /run/secrets/task_db_password)"
export TIMER_PASSWORD="$(cat /run/secrets/timer_db_password)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=auth_password="$AUTH_PASSWORD" --set=task_password="$TASK_PASSWORD" \
  --set=timer_password="$TIMER_PASSWORD" <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('CREATE ROLE auth LOGIN PASSWORD %L', :'auth_password') \gexec
SELECT format('CREATE ROLE task LOGIN PASSWORD %L', :'task_password') \gexec
SELECT format('CREATE ROLE timer LOGIN PASSWORD %L', :'timer_password') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO auth, task, timer', current_database()) \gexec
CREATE SCHEMA auth AUTHORIZATION auth;
CREATE SCHEMA task AUTHORIZATION task;
CREATE SCHEMA timer AUTHORIZATION timer;
SQL
unset AUTH_PASSWORD TASK_PASSWORD TIMER_PASSWORD
