"""Per-request tenant context using a ContextVar.

Resolution order (first match wins):
1. ``X-MLflow-Tenant`` HTTP request header.
2. Leftmost subdomain of the ``Host`` header (e.g. ``acme.mlflow.example.com`` → ``acme``).
3. Fall back to the ``DEFAULT_TENANT_SLUG`` ("default").

Middleware in ``mlflow.server.auth`` calls ``set_active_tenant_slug()`` at the
start of every request and ``reset_active_tenant_slug()`` in a finally block.
Application code and the auth store call ``get_active_tenant_slug()`` to read
the current request's tenant without passing it as a function argument.
"""

from __future__ import annotations

from contextvars import ContextVar

DEFAULT_TENANT_SLUG = "default"

_TENANT_HEADER = "X-MLflow-Tenant"

_active_tenant: ContextVar[str] = ContextVar("_active_tenant", default=DEFAULT_TENANT_SLUG)


def get_active_tenant_slug() -> str:
    return _active_tenant.get()


def set_active_tenant_slug(slug: str) -> object:
    """Set the active tenant and return the token needed to reset it."""
    return _active_tenant.set(slug)


def reset_active_tenant_slug(token: object) -> None:
    _active_tenant.reset(token)


def resolve_tenant_slug(request_headers: dict[str, str]) -> str:
    """Derive tenant slug from HTTP headers (header lookup is case-insensitive)."""
    # HTTP headers are case-insensitive; normalise the lookup to handle both
    # Flask's title-cased keys (X-Mlflow-Tenant) and the canonical form.
    header_lower = {k.lower(): v for k, v in request_headers.items()}
    if slug := header_lower.get(_TENANT_HEADER.lower(), "").strip():
        return slug

    host = request_headers.get("Host", "").split(":")[0]
    parts = host.split(".")
    # Require at least 4 parts (tenant.service.domain.tld) to avoid treating the
    # service hostname itself (mlflow.example.com) as a tenant subdomain.
    # Skip pure IPv4 addresses (all-numeric octets like 127.0.0.1).
    is_ipv4 = len(parts) == 4 and all(p.isdigit() for p in parts)
    if len(parts) >= 4 and not is_ipv4:
        candidate = parts[0]
        if candidate and candidate != "www":
            return candidate

    return DEFAULT_TENANT_SLUG
