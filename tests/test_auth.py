from datetime import timedelta
from uuid import uuid4

import jwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from shared.runtime import current_user, now


def test_registration_login_and_me(client, urls, account):
    user = account()
    login = client.post(f"{urls['auth']}/api/auth/login", json=user["credentials"])
    assert login.status_code == 200
    assert login.json()["token_type"] == "bearer"
    me = client.get(f"{urls['auth']}/api/auth/me", headers=user["headers"])
    assert me.json()["id"] == user["user"]["id"]
    assert "password_hash" not in me.json()
    duplicate = client.post(f"{urls['auth']}/api/auth/register", json=user["credentials"])
    assert duplicate.status_code == 409
    bad = client.post(
        f"{urls['auth']}/api/auth/login", json={**user["credentials"], "password": "wrong-password!"}
    )
    assert bad.status_code == 401
    assert client.get(f"{urls['auth']}/api/auth/me").status_code == 401


def test_password_validation(client, urls):
    response = client.post(f"{urls['auth']}/api/auth/register", json={"email": "bad", "password": "short"})
    assert response.status_code == 422


@pytest.mark.parametrize("change", ["expired", "issuer", "audience", "signature", "missing-exp", "algorithm"])
def test_jwt_validation(monkeypatch, change):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    monkeypatch.delenv("JWT_PUBLIC_KEY_FILE", raising=False)
    monkeypatch.setenv("JWT_PUBLIC_KEY", public.decode())
    claims = {
        "sub": str(uuid4()),
        "iat": now(),
        "exp": now() + timedelta(minutes=5),
        "iss": "daytick-auth",
        "aud": "daytick-api",
    }
    if change == "expired":
        claims["exp"] = now() - timedelta(seconds=5)
    elif change == "issuer":
        claims["iss"] = "attacker"
    elif change == "audience":
        claims["aud"] = "another-api"
    elif change == "missing-exp":
        del claims["exp"]
    signing_key = (
        rsa.generate_private_key(public_exponent=65537, key_size=2048) if change == "signature" else key
    )
    token = (
        jwt.encode(claims, "a" * 32, algorithm="HS256")
        if change == "algorithm"
        else jwt.encode(claims, signing_key, algorithm="RS256")
    )
    with pytest.raises(HTTPException) as exc:
        current_user(HTTPAuthorizationCredentials(scheme="Bearer", credentials=token))
    assert exc.value.status_code == 401


def test_passwords_are_hashed(account, service_processes):
    if not service_processes:
        pytest.skip("Database inspection only available in native test mode")
    from pwdlib import PasswordHash

    from shared.runtime import database

    user = account()
    with database("auth") as connection:
        stored = connection.execute(
            "SELECT password_hash FROM users WHERE id=%s", (user["user"]["id"],)
        ).fetchone()
    assert stored["password_hash"].startswith("$argon2id$")
    assert PasswordHash.recommended().verify(user["credentials"]["password"], stored["password_hash"])
