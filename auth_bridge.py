#!/usr/bin/env python3
"""
Identity bridge for MLflow multi-tenant server behind oauth2-proxy/nginx.

Priority order for every request:
  1. Trusted proxy identity header (X-Forwarded-Email) — set by oauth2-proxy
     in passthrough mode.
  2. oauth2-proxy cookie → local /oauth2/userinfo — handles the ALCF external
     nginx topology where auth_request validates sessions but proxies directly
     to MLflow, bypassing oauth2-proxy's header injection.
  3. HTTP Basic Auth — for trusted local callers (scripts, admin API).

Multi-tenant behaviour
  Each Globus user gets a personal tenant: huihuo.zheng@anl.gov → huihuo-zheng.
  The user is enrolled as team admin in their personal tenant and as a member in
  the "default" tenant (read access to legacy experiments).

Set in basic_auth.ini:
  authorization_function = auth_bridge:authenticate_request_globus_header
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import secrets
import urllib.request
from functools import lru_cache

from werkzeug.datastructures import Authorization

from mlflow.server.auth import (
    make_basic_auth_response,
    make_forbidden_response,
    request,
    store,
)
from mlflow.tenant_context import (
    DEFAULT_TENANT_SLUG,
    reset_active_tenant_slug,
    set_active_tenant_slug,
)


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _settings() -> dict:
    raw_admins = os.getenv("MLFLOW_BRIDGE_ADMIN_EMAILS", "")
    admins = {x.strip().lower() for x in raw_admins.split(",") if x.strip()}
    return {
        "header": os.getenv("MLFLOW_BRIDGE_USER_HEADER", "X-Forwarded-Email"),
        "required_secret": os.getenv("MLFLOW_BRIDGE_SHARED_SECRET", ""),
        "secret_header": os.getenv("MLFLOW_BRIDGE_SECRET_HEADER", "X-Bridge-Secret"),
        "auto_create": os.getenv("MLFLOW_BRIDGE_AUTO_CREATE_USERS", "true").lower() == "true",
        "basic_local_only": os.getenv("MLFLOW_BRIDGE_ALLOW_BASIC_FALLBACK_LOCAL_ONLY", "true").lower() == "true",
        "trusted_local_addrs": {
            x.strip().lower()
            for x in os.getenv("MLFLOW_BRIDGE_TRUSTED_LOCAL_ADDRS", "127.0.0.1,::1,localhost").split(",")
            if x.strip()
        },
        "admins": admins,
        "oauth2_proxy_userinfo": os.getenv(
            "MLFLOW_BRIDGE_OAUTH2_PROXY_USERINFO_URL",
            "http://127.0.0.1:8081/oauth2/userinfo",
        ),
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@contextlib.contextmanager
def _tenant_scope(slug: str):
    """Temporarily set the active tenant for provisioning calls."""
    token = set_active_tenant_slug(slug)
    try:
        yield
    finally:
        reset_active_tenant_slug(token)


def _derive_slug(email: str) -> str:
    """huihuo.zheng@anl.gov → huihuo-zheng"""
    local = email.split("@")[0].lower()
    return re.sub(r"[^a-z0-9]+", "-", local).strip("-")


def _resolve_via_cookie() -> str:
    """Resolve identity from oauth2-proxy session cookies.

    Forwards the browser's _oauth2_proxy_* cookies to the local
    /oauth2/userinfo endpoint and returns the email, or "" on failure.
    This handles the ALCF topology where the external nginx does auth_request
    for validation but bypasses oauth2-proxy when proxying to MLflow.
    """
    cookie_header = request.headers.get("Cookie", "")
    if "_oauth2_proxy" not in cookie_header:
        return ""

    cfg = _settings()
    url = str(cfg["oauth2_proxy_userinfo"])
    try:
        req = urllib.request.Request(
            url,
            headers={"Cookie": cookie_header, "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            if resp.status != 200:
                return ""
            data = json.loads(resp.read())
            return (data.get("email") or "").strip().lower()
    except Exception:
        return ""


def _provision(email: str, cfg: dict) -> str:
    """Idempotently create personal tenant, global user, and team memberships.

    Returns the personal tenant slug so the caller can set it as active.
    """
    slug = _derive_slug(email)
    is_global_admin = email in cfg["admins"]

    # 1. Create personal tenant if it doesn't exist yet.
    try:
        store.get_tenant(slug)
    except Exception:
        with _tenant_scope(DEFAULT_TENANT_SLUG):
            store.create_tenant(slug=slug, name=f"Personal: {email}")

    # 2. Create global user (in default tenant context) and enroll in default
    #    tenant for read access to legacy experiments.
    with _tenant_scope(DEFAULT_TENANT_SLUG):
        if not store.has_user(email):
            store.create_user(
                email,
                secrets.token_urlsafe(24),
                is_admin=is_global_admin,
                role="member",
            )
        else:
            # User exists — update default-tenant membership (idempotent).
            store.add_team_member(email, role="admin" if is_global_admin else "member")

    # 3. Enroll as admin in personal tenant.
    with _tenant_scope(slug):
        store.add_team_member(email, role="admin")

    return slug


# ---------------------------------------------------------------------------
# Authorization function (entry point called by MLflow auth middleware)
# ---------------------------------------------------------------------------

def authenticate_request_globus_header() -> Authorization:
    """MLflow authorization_function: Globus identity → per-user tenant."""
    cfg = _settings()

    # 1) Trusted proxy header (oauth2-proxy passthrough mode).
    identity_header = str(cfg["header"])
    username = (request.headers.get(identity_header) or "").strip().lower()

    if username:
        required_secret = str(cfg["required_secret"])
        if required_secret:
            presented = (request.headers.get(str(cfg["secret_header"])) or "").strip()
            if presented != required_secret:
                return make_basic_auth_response()

    # 2) Cookie → local oauth2-proxy userinfo (ALCF external nginx bypass).
    if not username:
        username = _resolve_via_cookie()

    if username:
        if bool(cfg["auto_create"]):
            personal_slug = _provision(username, cfg)
        else:
            personal_slug = _derive_slug(username)
        # Override the ContextVar so all downstream store calls use the
        # user's personal tenant for this request.
        set_active_tenant_slug(personal_slug)
        return Authorization("basic", {"username": username, "password": None})

    # 3) HTTP Basic Auth fallback (local callers: scripts, admin API).
    remote_addr = (request.remote_addr or "").strip().lower()
    is_trusted_local = remote_addr in cfg["trusted_local_addrs"]

    if request.authorization is not None:
        if bool(cfg["basic_local_only"]) and not is_trusted_local:
            return make_forbidden_response()
        u = request.authorization.username
        p = request.authorization.password
        if u and p and store.authenticate_user(u, p):
            return request.authorization

    if bool(cfg["basic_local_only"]) and not is_trusted_local:
        return make_forbidden_response()

    return make_basic_auth_response()
