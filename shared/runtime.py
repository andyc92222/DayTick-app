"""Infrastructure only: each service connects using its own database role/schema."""

import hashlib
import os
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID
from zoneinfo import ZoneInfo

import jwt
import psycopg
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from psycopg.rows import dict_row


def setting(name: str, default: str = "") -> str:
    filename = os.getenv(f"{name}_FILE")
    return Path(filename).read_text().strip() if filename else os.getenv(name, default)


def now():
    return datetime.now(timezone.utc)


def timezone_name():
    value = setting("APP_TIMEZONE", "Australia/Brisbane")
    ZoneInfo(value)
    return value


@contextmanager
def database(service: str):
    # Each connection is a transaction. Errors roll back automatically.
    with psycopg.connect(
        host=setting("DB_HOST", "localhost"),
        port=setting("DB_PORT", "5432"),
        dbname=setting("DB_NAME", "daytick"),
        user=setting(f"{service.upper()}_DB_USER", service),
        password=setting(f"{service.upper()}_DB_PASSWORD"),
        row_factory=dict_row,
        connect_timeout=5,
        options=f"-c search_path={service},public -c timezone=UTC",
    ) as connection:
        yield connection


def user_lock(connection, user_id: str):
    key = int.from_bytes(hashlib.sha256(user_id.encode()).digest()[:8], "big", signed=True)
    connection.execute("SELECT pg_advisory_xact_lock(%s)", (key,))


bearer = HTTPBearer(auto_error=False)


def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> str:
    try:
        if credentials is None:
            raise ValueError("Missing token")
        claims = jwt.decode(
            credentials.credentials,
            setting("JWT_PUBLIC_KEY"),
            algorithms=["RS256"],
            issuer=setting("JWT_ISSUER", "daytick-auth"),
            audience=setting("JWT_AUDIENCE", "daytick-api"),
            options={"require": ["exp", "iat", "sub", "iss", "aud"]},
        )
        return str(UUID(claims["sub"]))
    except (jwt.PyJWTError, ValueError, TypeError, KeyError):
        raise HTTPException(401, "Invalid or expired access token", headers={"WWW-Authenticate": "Bearer"})


def internal_auth(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    import secrets

    token = setting("INTERNAL_TOKEN")
    if not token or not credentials or not secrets.compare_digest(token, credentials.credentials):
        raise HTTPException(401, "Invalid service credentials")


def application(service: str, migration: Path):
    @asynccontextmanager
    async def lifespan(app):
        timezone_name()
        if not setting("JWT_PUBLIC_KEY"):
            raise RuntimeError("JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_FILE is required")
        with database(service) as connection:
            connection.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"migration:{service}",))
            connection.execute(migration.read_text())
        yield

    app = FastAPI(title=f"DayTick {service.title()} Service", lifespan=lifespan)

    @app.get("/health/live")
    def live():
        return {"status": "ok", "service": service}

    @app.get("/health/ready")
    def ready():
        try:
            with database(service) as connection:
                connection.execute("SELECT 1")
        except psycopg.Error:
            raise HTTPException(503, "Database unavailable")
        return {"status": "ready"}

    @app.exception_handler(psycopg.OperationalError)
    async def database_unavailable(request, exc):
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=503, content={"detail": "Database temporarily unavailable"})

    return app
