"""Cognito auth: verify caller JWTs and expose their role claims.

Verification happens in-process (PyJWT + Cognito's JWKS) rather than at the ALB --
this is a POC with no owned domain, and ALB-native Cognito auth requires an HTTPS
listener with an ACM cert, which can't be issued for AWS-owned hostnames.

Roles are plain strings that are literally Cognito Group names (see
config/agent-silos.ts), so there's no id/translation step: a caller's raw
`cognito:groups` claim is exactly the roles list `rag.py`'s filter needs. A role
irrelevant to a given silo (e.g. "HR-Manager" while querying `veridia`) simply never
matches any row there, since only that silo's own role names ever appear in its
`allowed_roles` column.
"""

import jwt
from fastapi import Depends, Header, HTTPException

from .config import get_settings


class UserContext:
    def __init__(self, sub: str, groups: list[str]) -> None:
        self.sub = sub
        self.groups = groups


class CognitoAuth:
    """JWKS-backed token verifier."""

    def __init__(self) -> None:
        self._settings = get_settings()
        self._jwks_client = jwt.PyJWKClient(f"{self._settings.cognito_issuer}/.well-known/jwks.json")

    def verify(self, token: str) -> UserContext:
        try:
            key = self._jwks_client.get_signing_key_from_jwt(token).key
            claims = jwt.decode(
                token, key, algorithms=["RS256"], issuer=self._settings.cognito_issuer,
                options={"verify_aud": False},  # Cognito puts the client id in `client_id`, not `aud`
            )
        except jwt.PyJWTError as exc:
            raise HTTPException(status_code=401, detail=f"invalid token: {exc}") from exc

        client_id = claims.get("client_id") or claims.get("aud")
        if client_id != self._settings.cognito_client_id:
            raise HTTPException(status_code=401, detail="token was not issued for this app")

        return UserContext(sub=claims.get("sub", ""), groups=claims.get("cognito:groups", []))


_auth = CognitoAuth()


def get_current_user(x_cognito_token: str | None = Header(default=None)) -> UserContext | None:
    """None means Unauthenticated (no/absent token) -- public-only retrieval."""
    if not x_cognito_token:
        return None
    return _auth.verify(x_cognito_token)


def require_user(user: UserContext | None = Depends(get_current_user)) -> UserContext:
    """Every real (non-admin) app route requires a logged-in user now that the SPA
    talks to the orchestrator directly -- there's no trusted intermediary anymore."""
    if user is None:
        raise HTTPException(status_code=401, detail="Cognito token required")
    return user


def require_superuser(user: UserContext = Depends(require_user)) -> UserContext:
    if "Superuser" not in user.groups:
        raise HTTPException(status_code=403, detail="Superuser role required")
    return user
