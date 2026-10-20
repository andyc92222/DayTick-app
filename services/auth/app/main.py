from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import jwt
from fastapi import Depends, HTTPException
from pwdlib import PasswordHash
from pydantic import BaseModel, ConfigDict, EmailStr, Field

from shared.runtime import application, current_user, database, now, setting, timezone_name

app = application("auth", Path(__file__).parents[1] / "migrations/001_initial.sql")
passwords = PasswordHash.recommended()
DUMMY_HASH = passwords.hash("constant-time-dummy-password")


class Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)


def token_for(user):
    issued = now()
    lifetime = int(setting("JWT_TTL_SECONDS", "3600"))
    token = jwt.encode(
        {
            "sub": str(user["id"]),
            "iat": issued,
            "exp": issued + timedelta(seconds=lifetime),
            "iss": setting("JWT_ISSUER", "daytick-auth"),
            "aud": setting("JWT_AUDIENCE", "daytick-api"),
        },
        setting("JWT_PRIVATE_KEY"),
        algorithm="RS256",
    )
    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": lifetime,
        "user": {"id": str(user["id"]), "email": user["email"]},
        "timezone": timezone_name(),
    }


@app.post("/api/auth/register", status_code=201)
def register(body: Credentials):
    hashed = passwords.hash(body.password)
    with database("auth") as connection:
        user = connection.execute(
            "INSERT INTO users(id,email,password_hash) VALUES (%s,%s,%s) "
            "ON CONFLICT(email) DO NOTHING RETURNING id,email",
            (uuid4(), str(body.email).lower(), hashed),
        ).fetchone()
        if not user:
            raise HTTPException(409, "An account with that email already exists")
    return token_for(user)


@app.post("/api/auth/login")
def login(body: Credentials):
    with database("auth") as connection:
        user = connection.execute("SELECT * FROM users WHERE email=%s", (str(body.email).lower(),)).fetchone()
    valid = passwords.verify(body.password, user["password_hash"] if user else DUMMY_HASH)
    if not user or not valid:
        raise HTTPException(401, "Incorrect email or password")
    return token_for(user)


@app.get("/api/auth/me")
def me(user_id: str = Depends(current_user)):
    with database("auth") as connection:
        user = connection.execute("SELECT id,email FROM users WHERE id=%s", (user_id,)).fetchone()
    if not user:
        raise HTTPException(401, "Account no longer exists")
    return {**user, "timezone": timezone_name()}
