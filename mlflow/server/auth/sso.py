"""SSO (Single Sign-On) support for MLflow multi-tenant.

Supported provider types
------------------------
  oidc    — Generic OpenID Connect (Keycloak, Okta, Auth0, etc.)
  github  — GitHub OAuth2
  google  — Google OAuth2 / OIDC
  globus  — Globus Auth (DOE facilities: ALCF, NERSC, OLCF)

Configuration
-------------
Add to basic_auth.ini::

    [sso]
    enabled = true
    server_url = https://mlflow.example.com

    [sso.providers.github]
    provider_type = github
    name = GitHub
    client_id = <your-github-app-client-id>
    client_secret = <your-github-app-client-secret>
    default_team = datascience
    default_role = member

    [sso.providers.google]
    provider_type = google
    name = Google
    client_id = <your-google-client-id>
    client_secret = <your-google-client-secret>
    username_claim = email

    [sso.providers.myidp]
    provider_type = oidc
    name = My Institution
    client_id = mlflow
    client_secret = <secret>
    discovery_url = https://sso.institution.edu/.well-known/openid-configuration
    username_claim = preferred_username
    default_team = research
    # Map SSO group names to team slugs (one per line, key=value)
    group_team_map =
        alcf-users=datascience
        perf-team=performance

    [sso.providers.globus]
    provider_type = globus
    name = Globus / ANL
    client_id = <globus-app-uuid>
    client_secret = <globus-app-secret>
    default_team = alcf
    username_claim = preferred_username

Session tokens
--------------
On successful SSO callback the server issues a signed HS256 JWT (24-hour
TTL, signed with MLFLOW_FLASK_SERVER_SECRET_KEY) and stores it in a cookie
called ``mlflow-sso-token``.  The auth middleware reads this cookie before
falling back to HTTP Basic Auth, so SSO and Basic Auth co-exist seamlessly.
"""

from __future__ import annotations

import configparser
import datetime
import logging
import os
import re
import secrets
from dataclasses import dataclass, field
from typing import Any

import jwt
import requests as _requests

_logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Public constants (imported by auth/__init__.py)
# ---------------------------------------------------------------------------

SSO_TOKEN_COOKIE = "mlflow-sso-token"
SSO_STATE_COOKIE = "mlflow-sso-state"
TOKEN_ALGORITHM = "HS256"
TOKEN_TTL_HOURS = 24


# ---------------------------------------------------------------------------
# Configuration dataclasses
# ---------------------------------------------------------------------------

@dataclass
class SSOProviderConfig:
    name: str
    provider_type: str          # "oidc" | "github" | "google" | "globus"
    client_id: str
    client_secret: str
    discovery_url: str = ""
    authorization_url: str = ""
    token_url: str = ""
    userinfo_url: str = ""
    scope: str = "openid email profile"
    username_claim: str = "email"
    default_role: str = "member"
    default_team: str = ""
    group_team_map: dict[str, str] = field(default_factory=dict)
    icon: str = ""


@dataclass
class SSOConfig:
    enabled: bool = False
    server_url: str = "http://localhost:5005"
    providers: dict[str, SSOProviderConfig] = field(default_factory=dict)


def load_sso_config(config_path: str) -> SSOConfig:
    """Parse SSO settings from basic_auth.ini."""
    cfg = configparser.ConfigParser()
    cfg.read(config_path)

    sso = SSOConfig()
    if not cfg.has_section("sso"):
        return sso

    sso.enabled = cfg.getboolean("sso", "enabled", fallback=False)
    sso.server_url = cfg.get(
        "sso", "server_url",
        fallback=os.environ.get("MLFLOW_SSO_SERVER_URL", "http://localhost:5005"),
    )

    for section in cfg.sections():
        if not section.startswith("sso.providers."):
            continue
        provider_id = section[len("sso.providers."):]
        group_map: dict[str, str] = {}
        for line in cfg.get(section, "group_team_map", fallback="").splitlines():
            line = line.strip()
            if "=" in line:
                k, _, v = line.partition("=")
                group_map[k.strip()] = v.strip()

        sso.providers[provider_id] = SSOProviderConfig(
            name=cfg.get(section, "name", fallback=provider_id.title()),
            provider_type=cfg.get(section, "provider_type", fallback="oidc"),
            client_id=cfg.get(section, "client_id", fallback=""),
            client_secret=cfg.get(section, "client_secret", fallback=""),
            discovery_url=cfg.get(section, "discovery_url", fallback=""),
            authorization_url=cfg.get(section, "authorization_url", fallback=""),
            token_url=cfg.get(section, "token_url", fallback=""),
            userinfo_url=cfg.get(section, "userinfo_url", fallback=""),
            scope=cfg.get(section, "scope", fallback="openid email profile"),
            username_claim=cfg.get(section, "username_claim", fallback="email"),
            default_role=cfg.get(section, "default_role", fallback="member"),
            default_team=cfg.get(section, "default_team", fallback=""),
            group_team_map=group_map,
            icon=cfg.get(section, "icon", fallback=""),
        )

    return sso


# ---------------------------------------------------------------------------
# OIDC discovery cache
# ---------------------------------------------------------------------------

_oidc_cache: dict[str, dict[str, Any]] = {}


def _fetch_oidc_discovery(url: str) -> dict[str, Any]:
    if url not in _oidc_cache:
        resp = _requests.get(url, timeout=10)
        resp.raise_for_status()
        _oidc_cache[url] = resp.json()
    return _oidc_cache[url]


# ---------------------------------------------------------------------------
# Provider endpoint resolution
# ---------------------------------------------------------------------------

def resolve_provider_endpoints(provider: SSOProviderConfig) -> SSOProviderConfig:
    """Fill in authorization/token/userinfo URLs from OIDC discovery if absent."""
    if provider.authorization_url and provider.token_url:
        return provider

    if provider.provider_type == "github":
        provider.authorization_url = "https://github.com/login/oauth/authorize"
        provider.token_url = "https://github.com/login/oauth/access_token"
        provider.userinfo_url = "https://api.github.com/user"
        provider.scope = "read:user user:email"
        return provider

    if provider.provider_type == "google":
        doc = _fetch_oidc_discovery(
            provider.discovery_url
            or "https://accounts.google.com/.well-known/openid-configuration"
        )
        provider.authorization_url = doc["authorization_endpoint"]
        provider.token_url = doc["token_endpoint"]
        provider.userinfo_url = doc["userinfo_endpoint"]
        provider.scope = "openid email profile"
        return provider

    if provider.provider_type == "globus":
        doc = _fetch_oidc_discovery(
            provider.discovery_url
            or "https://auth.globus.org/.well-known/openid-configuration"
        )
        provider.authorization_url = doc["authorization_endpoint"]
        provider.token_url = doc["token_endpoint"]
        provider.userinfo_url = doc["userinfo_endpoint"]
        provider.scope = "openid email profile"
        return provider

    if provider.provider_type == "oidc" and provider.discovery_url:
        doc = _fetch_oidc_discovery(provider.discovery_url)
        provider.authorization_url = doc["authorization_endpoint"]
        provider.token_url = doc["token_endpoint"]
        provider.userinfo_url = doc.get("userinfo_endpoint", "")
        return provider

    raise ValueError(
        f"Cannot resolve endpoints for provider '{provider.name}': "
        "set discovery_url or explicit authorization_url + token_url."
    )


# ---------------------------------------------------------------------------
# OAuth2 flow helpers
# ---------------------------------------------------------------------------

def build_authorization_url(
    provider: SSOProviderConfig,
    redirect_uri: str,
    state: str,
) -> str:
    """Return the provider's authorization URL."""
    from urllib.parse import urlencode
    provider = resolve_provider_endpoints(provider)
    params: dict[str, str] = {
        "client_id": provider.client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": provider.scope,
        "state": state,
    }
    if provider.provider_type in ("oidc", "google", "globus"):
        params["nonce"] = secrets.token_urlsafe(16)
    return f"{provider.authorization_url}?{urlencode(params)}"


def exchange_code_for_token(
    provider: SSOProviderConfig,
    code: str,
    redirect_uri: str,
) -> dict[str, Any]:
    """Exchange authorization code for access/ID tokens."""
    provider = resolve_provider_endpoints(provider)
    resp = _requests.post(
        provider.token_url,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": provider.client_id,
            "client_secret": provider.client_secret,
        },
        headers={"Accept": "application/json"},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def get_user_info(
    provider: SSOProviderConfig,
    token_response: dict[str, Any],
) -> dict[str, Any]:
    """Fetch user profile from the provider using the access token."""
    provider = resolve_provider_endpoints(provider)
    access_token = token_response.get("access_token", "")

    if provider.userinfo_url:
        resp = _requests.get(
            provider.userinfo_url,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
        resp.raise_for_status()
        info = resp.json()

        # GitHub: email may require a separate call if not public
        if provider.provider_type == "github" and not info.get("email"):
            try:
                emails_resp = _requests.get(
                    "https://api.github.com/user/emails",
                    headers={"Authorization": f"Bearer {access_token}"},
                    timeout=10,
                )
                if emails_resp.ok:
                    for e in emails_resp.json():
                        if e.get("primary"):
                            info["email"] = e["email"]
                            break
            except Exception:
                pass

        return info

    # Fallback: decode ID token claims (OIDC)
    id_token = token_response.get("id_token", "")
    if id_token:
        return jwt.decode(id_token, options={"verify_signature": False})

    raise ValueError("Cannot obtain user info: no userinfo_url and no id_token.")


def extract_username(user_info: dict[str, Any], provider: SSOProviderConfig) -> str:
    """Derive a clean MLflow username from provider user info."""
    raw = user_info.get(provider.username_claim, "")
    if not raw:
        for key in ("preferred_username", "login", "sub"):
            if user_info.get(key):
                raw = str(user_info[key])
                break
    if not raw:
        raise ValueError(f"Cannot extract username from SSO user info: {user_info}")
    # Sanitise to [a-z0-9._-], strip email domain
    clean = re.sub(r"[^a-z0-9._-]", "_", raw.lower().split("@")[0])
    return clean[:64]


def extract_groups(user_info: dict[str, Any]) -> list[str]:
    """Extract group/org memberships from user info (best-effort)."""
    for key in ("groups", "roles", "organizations", "orgs"):
        val = user_info.get(key, [])
        if isinstance(val, list):
            return [str(g) for g in val]
        if isinstance(val, str):
            return [s.strip() for s in val.split(",") if s.strip()]
    return []


# ---------------------------------------------------------------------------
# JWT session tokens
# ---------------------------------------------------------------------------

def issue_session_token(username: str, secret_key: str, ttl_hours: int = TOKEN_TTL_HOURS) -> str:
    """Issue a signed JWT session token for ``username``."""
    now = datetime.datetime.utcnow()
    payload = {
        "sub": username,
        "iat": now,
        "exp": now + datetime.timedelta(hours=ttl_hours),
        "type": "sso_session",
    }
    return jwt.encode(payload, secret_key, algorithm=TOKEN_ALGORITHM)


def verify_session_token(token: str, secret_key: str) -> str | None:
    """Verify an SSO JWT and return the username, or None if invalid/expired."""
    try:
        payload = jwt.decode(token, secret_key, algorithms=[TOKEN_ALGORITHM])
        if payload.get("type") != "sso_session":
            return None
        return payload.get("sub")
    except jwt.ExpiredSignatureError:
        _logger.debug("SSO session token expired")
        return None
    except jwt.InvalidTokenError as e:
        _logger.debug("SSO session token invalid: %s", e)
        return None
