"""OAuth2 / OIDC SSO for the MLflow multi-tenant auth plugin.

Supported provider types: google, globus, github, oidc (generic).

Config (basic_auth.ini):

    [sso]
    enabled = true
    server_url = http://18.220.172.200

    [sso.providers.google]
    provider_type = google
    name = Google
    client_id = <your-client-id>.apps.googleusercontent.com
    client_secret = GOCSPX-...
    scope = openid email profile
    username_claim = email        # strip @domain for short usernames
    default_team = default
    default_role = member

    [sso.providers.globus]
    provider_type = globus
    name = Globus / ANL
    client_id = ...
    ...
"""

from __future__ import annotations

import configparser
import hashlib
import hmac
import json
import logging
import os
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Optional

import requests as _requests

_logger = logging.getLogger(__name__)

SSO_STATE_COOKIE = "mlflow_sso_state"
SSO_TOKEN_COOKIE = "mlflow_sso_token"
_SESSION_TOKEN_TTL = 60 * 60 * 12  # 12 hours

# ── Provider endpoint catalogue ──────────────────────────────────────────────

_ENDPOINTS: dict[str, dict] = {
    "google": {
        "authorization_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "userinfo_url": "https://www.googleapis.com/oauth2/v3/userinfo",
        "default_scope": "openid email profile",
        "username_claim": "email",
        "icon": "google",
    },
    "globus": {
        "authorization_url": "https://auth.globus.org/v2/oauth2/authorize",
        "token_url": "https://auth.globus.org/v2/oauth2/token",
        "userinfo_url": "https://auth.globus.org/v2/oauth2/userinfo",
        "default_scope": "openid email profile",
        "username_claim": "preferred_username",
        "icon": "globus",
    },
    "github": {
        "authorization_url": "https://github.com/login/oauth/authorize",
        "token_url": "https://github.com/login/oauth/access_token",
        "userinfo_url": "https://api.github.com/user",
        "default_scope": "read:user user:email",
        "username_claim": "login",
        "icon": "github",
    },
}


# ── Data classes (object-based API used by __init__.py) ──────────────────────

@dataclass
class SSOProvider:
    id: str
    provider_type: str
    name: str
    icon: str
    client_id: str
    client_secret: str
    scope: str
    username_claim: str
    default_team: str
    default_role: str
    authorization_url: str
    token_url: str
    userinfo_url: str
    redirect_uri: str
    group_team_map: dict = field(default_factory=dict)
    # Optional allowlist — if non-empty only these emails may sign in.
    # Leave empty to allow any authenticated account.
    allowed_emails: frozenset = field(default_factory=frozenset)


@dataclass
class SSOConfig:
    enabled: bool
    server_url: str
    providers: dict[str, SSOProvider] = field(default_factory=dict)


# ── Config loader ────────────────────────────────────────────────────────────

def load_sso_config(config_path: str) -> SSOConfig:
    """Parse [sso] and [sso.providers.*] sections and return an SSOConfig."""
    disabled = SSOConfig(enabled=False, server_url="")

    if not config_path or not os.path.exists(config_path):
        return disabled

    cp = configparser.ConfigParser()
    cp.read(config_path)

    if "sso" not in cp or not cp.getboolean("sso", "enabled", fallback=False):
        return disabled

    server_url = cp.get("sso", "server_url", fallback="").rstrip("/")
    providers: dict[str, SSOProvider] = {}

    for section in cp.sections():
        if not section.startswith("sso.providers."):
            continue
        pid = section[len("sso.providers."):]
        ptype = cp.get(section, "provider_type", fallback=pid)
        defaults = _ENDPOINTS.get(ptype, {})

        # group_team_map: comma-separated "globus-group=team-slug" pairs
        raw_map = cp.get(section, "group_team_map", fallback="")
        group_map: dict[str, str] = {}
        for pair in raw_map.split(","):
            pair = pair.strip()
            if "=" in pair:
                g, t = pair.split("=", 1)
                group_map[g.strip()] = t.strip()

        # allowed_emails: comma-separated list; empty = allow any account.
        # Multiple identities (different email domains, same local part) map to
        # the same MLflow username automatically via extract_username() which
        # strips the @domain. Add all email variants here to allow them.
        raw_emails = cp.get(section, "allowed_emails", fallback="")
        allowed = frozenset(
            e.strip().lower() for e in raw_emails.split(",") if e.strip()
        )

        providers[pid] = SSOProvider(
            id=pid,
            provider_type=ptype,
            name=cp.get(section, "name", fallback=pid.title()),
            icon=cp.get(section, "icon", fallback=defaults.get("icon", ptype)),
            client_id=cp.get(section, "client_id", fallback=""),
            client_secret=cp.get(section, "client_secret", fallback=""),
            scope=cp.get(section, "scope", fallback=defaults.get("default_scope", "openid email profile")),
            username_claim=cp.get(section, "username_claim", fallback=defaults.get("username_claim", "email")),
            default_team=cp.get(section, "default_team", fallback="default"),
            default_role=cp.get(section, "default_role", fallback="member"),
            authorization_url=cp.get(section, "authorization_url", fallback=defaults.get("authorization_url", "")),
            token_url=cp.get(section, "token_url", fallback=defaults.get("token_url", "")),
            userinfo_url=cp.get(section, "userinfo_url", fallback=defaults.get("userinfo_url", "")),
            redirect_uri=f"{server_url}/sso/callback/{pid}",
            group_team_map=group_map,
            allowed_emails=allowed,
        )
        _logger.debug("Loaded SSO provider %r (type=%s)", pid, ptype)

    return SSOConfig(enabled=True, server_url=server_url, providers=providers)


# ── OAuth2 helpers ───────────────────────────────────────────────────────────

def build_authorization_url(provider: SSOProvider, redirect_uri: str, state: str) -> str:
    """Build the URL that the browser is redirected to for login."""
    params: dict[str, str] = {
        "client_id": provider.client_id,
        "response_type": "code",
        "scope": provider.scope,
        "redirect_uri": redirect_uri,
        "state": state,
    }
    if provider.provider_type == "google":
        params["access_type"] = "online"
    elif provider.provider_type == "globus":
        params["prompt"] = "login"
    return provider.authorization_url + "?" + urllib.parse.urlencode(params)


def exchange_code_for_token(provider: SSOProvider, code: str, redirect_uri: str) -> dict:
    """Exchange the authorization code for access/ID tokens."""
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
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def get_user_info(provider: SSOProvider, token: dict) -> dict:
    """Fetch user info from the provider's userinfo endpoint."""
    resp = _requests.get(
        provider.userinfo_url,
        headers={
            "Authorization": f"Bearer {token.get('access_token', '')}",
            "Accept": "application/json",
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def extract_username(user_info: dict, provider: SSOProvider) -> str:
    """Derive a short, URL-safe username from provider identity claims.

    Multiple email identities (e.g. user@anl.gov, user@americansciencecloud.org,
    user@gmail.com) all map to the same MLflow username ``user`` because the
    @domain part is stripped.  Add all allowed email variants to the
    ``allowed_emails`` list in basic_auth.ini to control who may sign in.
    """
    claim = provider.username_claim
    email_from_info = str(user_info.get("email", "")).strip().lower()

    # Allowlist check — runs before username derivation so blocked users see
    # a clear error rather than a 500.
    if provider.allowed_emails and email_from_info:
        if email_from_info not in provider.allowed_emails:
            raise ValueError(
                f"The email {email_from_info!r} is not authorised to access this "
                "MLflow instance. Contact your administrator to be added."
            )

    username = str(user_info.get(claim, "")).strip()

    # Fallback chain
    if not username:
        for key in ("preferred_username", "email", "login", "sub"):
            if user_info.get(key):
                username = str(user_info[key])
                break

    if not username:
        raise ValueError("Could not extract a username from the SSO identity claims")

    # Strip @domain so multiple email domains (same local part) share one account
    if "@" in username and claim in ("email", "preferred_username"):
        username = username.split("@")[0]

    return username.lower()


def extract_groups(user_info: dict) -> list[str]:
    """Return group/role memberships if the provider exposes them."""
    return user_info.get("groups", [])


# ── Session token (HMAC-SHA256 — no external JWT dependency) ─────────────────

def issue_session_token(username: str, secret_key: str) -> str:
    payload = json.dumps({"sub": username, "iat": int(time.time())}, separators=(",", ":"))
    # Use quote(safe='') so ALL characters including '.' are percent-encoded —
    # this prevents usernames like 'huihuo.zheng' from inserting unencoded dots
    # that would confuse the '.' separator between b64 and sig.
    b64 = urllib.parse.quote(payload, safe="")
    sig = hmac.new(secret_key.encode(), b64.encode(), hashlib.sha256).hexdigest()
    return f"{b64}.{sig}"


def verify_session_token(token: str, secret_key: str) -> Optional[str]:
    try:
        # rsplit from the right: the HMAC sig (64 hex chars) has no dots;
        # the b64 payload may have dots if an older token used quote_plus.
        b64, sig = token.rsplit(".", 1)
        expected = hmac.new(secret_key.encode(), b64.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(urllib.parse.unquote(b64))
        if int(time.time()) - payload.get("iat", 0) > _SESSION_TOKEN_TTL:
            return None
        return payload.get("sub")
    except Exception:
        return None
