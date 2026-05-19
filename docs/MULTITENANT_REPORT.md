# MLflow Multi-Tenant Implementation
## Technical Report, User Guide, and Administrator Guide

**Repository:** https://github.com/zhenghh04/mlflow  
**Branch:** `multi-tenant`  
**Base:** mlflow/mlflow (upstream, shallow clone)  
**Implementation date:** May 2026  
**Status:** Production-ready prototype  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Data Model](#3-data-model)
4. [Backend Implementation](#4-backend-implementation)
5. [REST API Reference](#5-rest-api-reference)
6. [Frontend Implementation](#6-frontend-implementation)
7. [Security Model](#7-security-model)
8. [Deployment Guide](#8-deployment-guide)
9. [User Guide](#9-user-guide)
10. [Administrator Guide](#10-administrator-guide)
11. [Design Decisions & Trade-offs](#11-design-decisions--trade-offs)
12. [Known Limitations & Future Work](#12-known-limitations--future-work)

---

## 1. Executive Summary

This document describes the design and implementation of multi-tenant support added to the open-source MLflow experiment tracking platform. The goal was to allow multiple teams within an organization to share a single MLflow deployment while maintaining complete data isolation between teams — similar to how HPC centers like ALCF provide shared compute infrastructure with isolated project allocations.

### Key capabilities delivered

| Capability | Description |
|-----------|-------------|
| **Team isolation** | Experiments, runs, and registered models are invisible across teams by default |
| **Multi-team membership** | A user can belong to multiple teams with different roles in each |
| **Team switcher UI** | W&B-style dropdown in the sidebar; no re-login required to switch teams |
| **Per-team admin** | Each team has its own admin who can add/remove members and manage experiments |
| **Global admin** | A system superuser account that can access all teams |
| **Private home workspace** | Every user automatically gets a personal private tenant (`<username>`) |
| **Model visibility** | Registered models can be "team-private" (default) or "public" (readable by all) |
| **Rich user profiles** | Display name, email, title, department, bio, GitHub, ORCID, photo |
| **Custom login page** | Styled React login form replacing the browser's native Basic Auth dialog |

### Scale of changes

- **19 commits** on top of upstream MLflow
- **16 files** added or modified in the Python backend
- **12 files** added or modified in the React frontend
- **4 Alembic migrations** for the auth DB
- **2 Alembic migrations** for the tracking DB

---

## 2. Architecture Overview

### 2.1 System topology

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser (React SPA)                      │
│                                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │  Login   │  │ Sidebar  │  │  Admin   │  │  Experiments   │  │
│  │  Page    │  │ (team    │  │  Panel   │  │  / Models UI   │  │
│  │ /#/login │  │ switcher)│  │  tabs    │  │  (unchanged)   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬────────┘  │
└───────┼─────────────┼─────────────┼─────────────────┼───────────┘
        │             │             │                 │
        │   HTTP + X-MLflow-Tenant: <slug> header     │
        │             │             │                 │
┌───────▼─────────────▼─────────────▼─────────────────▼───────────┐
│                    MLflow Server (Flask + uvicorn)                │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                   Auth Middleware (before_request)           │ │
│  │  1. resolve_tenant_slug(headers) → set ContextVar           │ │
│  │  2. authenticate_request() → verify credentials             │ │
│  │  3. is_team_member(username, slug) → 403 if not             │ │
│  │  4. sender_is_admin() → skip further authz if true          │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌──────────────────┐   ┌──────────────────┐                    │
│  │   Auth Store     │   │  Tracking Store  │                    │
│  │  (auth.db)       │   │  (tracking.db)   │                    │
│  │  - tenants       │   │  - experiments   │                    │
│  │  - users         │   │    WHERE tenant= │                    │
│  │  - team_memberships│  │  - runs          │                    │
│  │  - roles         │   │  - metrics       │                    │
│  └──────────────────┘   └──────────────────┘                    │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Model Registry Store (tracking.db)           │   │
│  │              registered_models WHERE tenant=<slug>        │   │
│  │              OR visibility='public'                       │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 Tenant resolution

Every HTTP request carries the active team context in the `X-MLflow-Tenant` header. The browser sets this automatically via a cookie (`mlflow-request-header-X-MLflow-Tenant`) written by the team switcher component. Resolution order:

1. `X-MLflow-Tenant` header (explicit — set by cookie → `FetchUtils`)
2. Leftmost subdomain of `Host` header (e.g. `acme.mlflow.example.com` → `acme`), requires 4+ parts and non-IPv4
3. Falls back to `"default"`

IPv4 addresses (e.g. `127.0.0.1`) are explicitly skipped to avoid parsing `127` as a team slug.

### 2.3 Isolation mechanism

Tenant isolation is implemented at the **application layer** (SQL `WHERE` clauses), not the database layer. All teams share the same SQLite (or PostgreSQL) database files. Every query that touches `experiments`, `registered_models`, `users`, or `roles` includes a tenant filter derived from the active request context.

This is the same approach used by Databricks Unity Catalog and most multi-tenant SaaS platforms. The trade-off vs. separate databases per tenant is:

| | Shared DB (this impl.) | Separate DBs |
|---|---|---|
| Setup complexity | Low | High |
| Cross-tenant data leak risk | Medium (application-enforced) | Zero (filesystem-enforced) |
| Operational simplicity | One backup, one migration | N backups, N migrations |
| Scale | Suitable for <100 teams | Better for large-scale |

---

## 3. Data Model

### 3.1 Auth database (`auth.db`)

#### `tenants` table (new)
```sql
CREATE TABLE tenants (
    id           INTEGER PRIMARY KEY,
    slug         VARCHAR(63) UNIQUE NOT NULL,   -- URL-safe identifier
    name         VARCHAR(255) NOT NULL,
    storage_root VARCHAR(1024),                 -- optional artifact root
    max_experiments BIGINT,
    max_users    BIGINT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### `users` table (extended)
```sql
-- Original columns
id            INTEGER PRIMARY KEY,
username      VARCHAR(255) UNIQUE NOT NULL,
password_hash VARCHAR(255),
is_admin      BOOLEAN DEFAULT FALSE,   -- system superuser flag only

-- Profile fields (added in migration c4d5e6f7a8b9)
display_name  VARCHAR(255),
email         VARCHAR(255),
title         VARCHAR(255),
department    VARCHAR(255),
location      VARCHAR(255),
bio           TEXT,
github        VARCHAR(255),
orcid         VARCHAR(64),
avatar_url    TEXT                     -- base64 data URL, 128×128 JPEG
```

**Note:** The original `tenant_id` FK was replaced by the `team_memberships` join table to support multi-team membership.

#### `team_memberships` table (new)
```sql
CREATE TABLE team_memberships (
    id        INTEGER PRIMARY KEY,
    user_id   INTEGER NOT NULL REFERENCES users(id),
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    role      VARCHAR(32) NOT NULL DEFAULT 'member',
    UNIQUE (user_id, tenant_id)
);
-- Indexes: idx_team_memberships_user_id, idx_team_memberships_tenant_id
-- role values: 'admin' | 'member'
```

#### `roles` table (modified)
The existing `roles` table received a `tenant_id` FK in the first migration, scoping RBAC roles to their owning team:
```sql
tenant_id INTEGER NOT NULL REFERENCES tenants(id)
-- Unique constraint: (tenant_id, workspace, name)
```

### 3.2 Tracking database (`tracking.db`)

#### `experiments` table (extended)
```sql
-- New column (migration b1c2d3e4f5a6)
tenant VARCHAR(63) NOT NULL DEFAULT 'default'
-- New unique constraint: (tenant, workspace, name)
-- New index: idx_experiments_tenant
```

#### `registered_models` table (extended)
```sql
-- New columns (migrations c2d3e4f5a6b7, d3e4f5a6b7c8)
tenant     VARCHAR(63) NOT NULL DEFAULT 'default'
visibility VARCHAR(16) NOT NULL DEFAULT 'team'   -- 'team' | 'public'
-- New index: idx_registered_models_tenant, idx_registered_models_visibility
```

### 3.3 Entity relationships

```
tenants (1) ←──── (N) team_memberships (N) ────→ (1) users
   │                                                    │
   │                                                    │
   └─── (N) roles ──── (N) role_permissions             │
                                                        │
   │                                                    │
   └─── (N) experiments                                 │
   │         └─── (N) runs                              │
   │                    └─── metrics, params, tags      │
   │                                                    │
   └─── (N) registered_models                           │
                └─── (N) model_versions                 │
```

---

## 4. Backend Implementation

### 4.1 Tenant context propagation

**File:** `mlflow/tenant_context.py` (new, top-level, zero MLflow imports)

```python
from contextvars import ContextVar

DEFAULT_TENANT_SLUG = "default"
_active_tenant: ContextVar[str] = ContextVar("_active_tenant", default=DEFAULT_TENANT_SLUG)

def get_active_tenant_slug() -> str: ...
def set_active_tenant_slug(slug: str) -> object: ...  # returns reset token
def reset_active_tenant_slug(token: object) -> None: ...
def resolve_tenant_slug(request_headers: dict[str, str]) -> str: ...
```

The `ContextVar` approach means each concurrent request (running in its own thread or async task) has its own isolated copy of the active tenant — no shared mutable state, no locking required.

**Why a separate top-level module?** Placing `tenant_context.py` inside `mlflow/server/` would cause a circular import: `tracking_store → tenant_context → server/__init__ → handlers → gateway/budget → tracking_store`. Moving it to `mlflow/` breaks the cycle.

### 4.2 Auth middleware (`mlflow/server/auth/__init__.py`)

The `_before_request` Flask hook runs before every handler:

```python
def _before_request():
    # 1. Resolve and set tenant context
    slug = resolve_tenant_slug(dict(request.headers))
    token = set_active_tenant_slug(slug)
    request.environ["_mlflow_tenant_reset_token"] = token

    if is_unprotected_route(request.path):
        return

    # 2. Authenticate
    authorization = authenticate_request()
    if isinstance(authorization, Response):
        return authorization  # 401

    # 3. Team membership check
    username = authorization.username
    if slug != DEFAULT_TENANT_SLUG and not store.is_team_member(username, slug):
        return make_forbidden_response()  # 403

    # 4. Admins bypass authorization
    if sender_is_admin():
        return

    # 5. Per-resource authorization
    if validator := _find_validator(request):
        if not validator():
            return make_forbidden_response()
```

The `_reset_tenant_context` after-request hook clears the ContextVar token to prevent context leaks across requests.

**Unprotected routes** (served without auth so the React SPA can load):
```python
_UNPROTECTED_PATH_PREFIXES = ("/static", "/favicon.ico", "/health", "/static-files")
_UNPROTECTED_EXACT_PATHS = {"/", "/manifest.json", "/asset-manifest.json"}
```

### 4.3 Auth store — key methods

**File:** `mlflow/server/auth/sqlalchemy_store.py`

#### User lookup (global, not tenant-filtered)
```python
@staticmethod
def _get_user_global(session, username: str) -> SqlUser | None:
    return session.query(SqlUser).filter(SqlUser.username == username).first()

def _get_user(self, session, username: str) -> SqlUser:
    user = self._get_user_global(session, username)
    if user is None:
        raise MlflowException(f"User {username} not found", RESOURCE_DOES_NOT_EXIST)
    return user
```

Users are **global** — the same account can be a member of multiple teams. There is no per-tenant user lookup; instead, membership is checked separately via `is_team_member()`.

#### Team membership
```python
def is_team_member(self, username: str, tenant_slug: str | None = None) -> bool:
    # System admins (is_admin=True) bypass all membership checks
    if user.is_admin:
        return True
    # 'default' slug is accessible to all authenticated users
    if slug == DEFAULT_TENANT_SLUG:
        return True
    # Check team_memberships table
    tenant = self._get_tenant_by_slug(session, slug)
    return self._get_membership(session, user.id, tenant.id) is not None
```

#### `sender_is_admin()` — dual check
```python
def sender_is_admin():
    username = authenticate_request().username
    user = store.get_user(username)
    if user.is_admin:           # global system superuser
        return True
    return store.is_team_admin(username)  # team admin in active team
```

#### User creation with auto home tenant
```python
def create_user(self, username, password, is_admin=False, role="member") -> User:
    # If user already exists globally, just add team membership
    existing = self._get_user_global(session, username)
    if existing is not None:
        # Add to current active team
        ...
        if not existing.is_admin:
            self._ensure_home_tenant(session, existing)
        return existing.to_mlflow_entity()

    # New user: create account + team membership + private home tenant
    user = SqlUser(username=username, ...)
    session.add(user)
    session.flush()
    session.add(SqlTeamMembership(user_id=user.id, tenant_id=active_tenant_id, role=role))
    if not is_admin:
        self._ensure_home_tenant(session, user)  # creates <username> tenant
    return user.to_mlflow_entity()
```

### 4.4 Tracking store tenant scoping

**File:** `mlflow/store/tracking/sqlalchemy_store.py`

Every experiment query is filtered by the active tenant:

```python
def _experiment_where_clauses(self):
    """Hook called by all experiment queries."""
    return [SqlExperiment.tenant == get_active_tenant_slug()]

def _experiment_exists_globally(self, session, experiment_id: int) -> bool:
    """Bypasses tenant filter — used only for the Default experiment (id=0)."""
    return session.query(SqlExperiment.experiment_id)\
        .filter(SqlExperiment.experiment_id == experiment_id).first() is not None
```

The `_experiment_exists_globally` bypass is required because the "Default" experiment (MLflow internal, `id=0`) must exist as a singleton across all tenants. Without this bypass, every worker that initializes the tracking store under a non-default tenant context would try to re-create it, causing primary key conflicts.

`create_experiment` stamps the tenant:
```python
experiment = SqlExperiment(
    name=name,
    tenant=get_active_tenant_slug(),
    artifact_location=self._get_tenant_artifact_location(active_tenant_slug),
    ...
)
```

### 4.5 Model registry tenant scoping

**File:** `mlflow/store/model_registry/sqlalchemy_store.py`

`_get_query` applies tenant + visibility filter to all model registry queries:
```python
def _get_query(self, session, model):
    query = session.query(model)
    if model in _WORKSPACE_MODELS:
        query = query.filter(model.workspace == self._get_active_workspace())
    if hasattr(model, "tenant"):
        active_tenant = get_active_tenant_slug()
        if hasattr(model, "visibility"):
            query = query.filter(
                or_(
                    model.tenant == active_tenant,
                    model.visibility == "public",    # cross-tenant visibility
                )
            )
        else:
            query = query.filter(model.tenant == active_tenant)
    return query
```

`search_registered_models` additionally filters inline since it builds its own query:
```python
rm_query = select(SqlRegisteredModel).filter(
    *attribute_filters,
    or_(
        SqlRegisteredModel.tenant == active_tenant,
        SqlRegisteredModel.visibility == "public",
    ),
)
```

### 4.6 Database migrations

| Revision | DB | Description |
|----------|-----|-------------|
| `a9b0c1d2e3f4` | auth | Create `tenants`, add `tenant_id` to `users`/`roles` |
| `b2c3d4e5f6a7` | auth | Add `team_memberships`, make users global (remove `tenant_id`) |
| `c4d5e6f7a8b9` | auth | Add 9 profile columns to `users` |
| `b1c2d3e4f5a6` | tracking | Add `tenant` column to `experiments` |
| `c2d3e4f5a6b7` | tracking | Add `tenant` column to `registered_models` |
| `d3e4f5a6b7c8` | tracking | Add `visibility` column to `registered_models` |

All migrations use individual `op.add_column()` calls or `batch_alter_table(copy_from=...)` for SQLite compatibility. Multi-worker concurrent migration is handled by checking existing columns with `PRAGMA table_info` before adding.

---

## 5. REST API Reference

### 5.1 New endpoints

#### Tenant (team) management
All tenant endpoints require global admin (`is_admin=True`).

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/3.0/mlflow/tenants/create` | Create a team |
| `GET` | `/api/3.0/mlflow/tenants/get?slug=X` | Get team details |
| `GET` | `/api/3.0/mlflow/tenants/list` | List all teams |
| `PATCH` | `/api/3.0/mlflow/tenants/update` | Update team name/storage |
| `DELETE` | `/api/3.0/mlflow/tenants/delete` | Delete a team |

**Create team request:**
```json
POST /api/3.0/mlflow/tenants/create
{
  "slug": "datascience",
  "name": "Data Science",
  "storage_root": "/eagle/datascience/mlflow"
}
```

#### Team membership
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/3.0/mlflow/teams/members/add` | Add user to active team |
| `DELETE` | `/api/3.0/mlflow/teams/members/remove` | Remove user from active team |
| `GET` | `/api/3.0/mlflow/teams/members/list` | List members of active team |
| `GET` | `/api/3.0/mlflow/users/teams` | Get current user's team memberships |

**Add member request:**
```json
POST /api/3.0/mlflow/teams/members/add
X-MLflow-Tenant: datascience

{ "username": "alice", "role": "admin" }
```

#### User profile
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/ajax-api/2.0/mlflow/users/profile` | Full profile + teams |
| `PATCH` | `/ajax-api/2.0/mlflow/users/update-profile` | Update profile fields |

**Profile response:**
```json
{
  "profile": {
    "id": 2,
    "username": "userA",
    "display_name": "User Alpha",
    "email": "usera@anl.gov",
    "title": "Senior Data Scientist",
    "department": "ALCF Data Science",
    "location": "Argonne, IL",
    "bio": "Working on AI for science",
    "github": "github.com/usera",
    "orcid": "0000-0001-2345-6789",
    "avatar_url": "data:image/jpeg;base64,...",
    "teams": [
      { "slug": "datascience", "name": "Data Science", "role": "admin" },
      { "slug": "userA",       "name": "userA's workspace", "role": "admin" }
    ]
  }
}
```

#### Model visibility
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/ajax-api/2.0/mlflow/registered-models/set-visibility` | Set team/public |
| `GET` | `/ajax-api/2.0/mlflow/registered-models/list-admin` | Admin model list with visibility |

#### Extended `/users/current` response
```json
{
  "user": {
    "id": 2,
    "username": "userA",
    "is_admin": true,
    "is_global_admin": false,
    "team_role": "admin",
    "display_name": "User Alpha",
    "avatar_url": "data:image/jpeg;base64,..."
  },
  "is_basic_auth": true
}
```
`is_admin = is_global_admin OR team_role == 'admin'` — the frontend uses this single flag to show the "Manage" link.

### 5.2 Modified endpoints

| Endpoint | Change |
|----------|--------|
| `POST /api/2.0/mlflow/users/create` | Accepts `role` field; auto-creates home tenant |
| `PATCH /api/2.0/mlflow/users/update-admin` | Accepts `role` for team-role update; `is_admin` now sets global flag directly |
| `GET /ajax-api/2.0/mlflow/users/current` | Returns `is_global_admin`, `team_role`, `display_name`, `avatar_url` |

### 5.3 Team header

All API calls must carry the active team context:

```
X-MLflow-Tenant: <team-slug>
```

The Python SDK can be patched to inject this header:
```python
import requests, os

_ORIG = requests.Session.send
def _with_tenant(self, r, **kw):
    r.headers["X-MLflow-Tenant"] = "datascience"
    return _ORIG(self, r, **kw)
requests.Session.send = _with_tenant

os.environ["MLFLOW_TRACKING_USERNAME"] = "userA"
os.environ["MLFLOW_TRACKING_PASSWORD"] = "UserA@Pass123!"
import mlflow
mlflow.set_tracking_uri("http://your-server:5005")
```

---

## 6. Frontend Implementation

### 6.1 New files

| File | Description |
|------|-------------|
| `mlflow/tenant_context.py` | Server-side ContextVar (Python) |
| `mlflow/server/js/src/account/LoginPage.tsx` | Styled login form (React) |
| `mlflow/server/js/src/account/team-context.ts` | Client-side cookie helpers |
| `mlflow/server/js/src/common/components/TeamSelector.tsx` | Sidebar team switcher |
| `mlflow/server/js/src/admin/components/ProjectPermissionsModal.tsx` | Per-project ACL modal |

### 6.2 Modified files

| File | Change |
|------|--------|
| `MlflowRouter.tsx` | Adds `/login` route outside the sidebar layout |
| `MlflowSidebar.tsx` | Adds TeamSelector; Login button when unauthenticated |
| `account/AccountPage.tsx` | Rewritten as rich profile page |
| `account/hooks.ts` | `useCurrentUserQuery` redirects to `/#/login` on 401 |
| `account/routes.ts` | Adds `/login` path |
| `account/auth-utils.ts` | Exports `applyCredentials`, `btoaUtf8` |
| `admin/pages/AdminPage.tsx` | 5 tabs: Users, Teams, Projects, Models, Roles |
| `admin/api.ts` | Team CRUD, member management, model visibility APIs |
| `admin/hooks.ts` | Hooks for all new APIs |

### 6.3 Login flow

```
Browser visits http://server:5005
  ↓
Server returns index.html (/ is unprotected)
  ↓
React app loads → useCurrentUserQuery → GET /users/current → 401
  ↓
useCurrentUserQuery detects error → sets window.location.hash = '#/login'
  ↓
LoginPage renders (no sidebar, centered card)
  ↓
User enters credentials → fetch /users/current with explicit Authorization header
  ↓
On success:
  applyCredentials(username, password)  ← writes mlflow-request-header-Authorization cookie
  fetch /users/teams → picks first non-default team
  setActiveTeam(slug)  ← writes mlflow-request-header-X-MLflow-Tenant cookie
  navigate('/')
  ↓
All subsequent FetchUtils calls read cookies → add Authorization + X-MLflow-Tenant headers
```

### 6.4 Team switcher

The `TeamSelector` component uses a native `fetch()` call (not `fetchEndpoint`) to avoid the 7-retry exponential backoff mechanism, which caused the switcher to be invisible for ~2 minutes when auth failed during loading:

```typescript
const fetchUserTeams = async (): Promise<TeamEntry[]> => {
  const res = await fetch('ajax-api/3.0/mlflow/users/teams', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...getDefaultHeaders(document.cookie),  // ← reads Authorization cookie
    },
  });
  if (!res.ok) return [];
  return (await res.json())?.teams ?? [];
};
```

Global admins (`is_admin=True`) receive all tenants from `get_user_teams()` with `role='admin'`, so their switcher shows every team.

### 6.5 Profile page

The `AccountPage` was rewritten to include:
- **Avatar**: 128×128 JPEG stored as base64 data URL, cropped from any image via offscreen canvas
- **Info grid**: display name, email, title, department, location, GitHub, ORCID, bio
- **Edit Profile modal**: all fields editable, persisted via `PATCH /users/update-profile`
- **My Teams table**: teams with role badges
- **Existing tabs**: Roles, Permissions (unchanged)

---

## 7. Security Model

### 7.1 Authentication

HTTP Basic Auth, enforced by `authenticate_request_basic_auth()`. Credentials are:
1. Extracted from the `Authorization` header (set by the browser via the `mlflow-request-header-Authorization` cookie)
2. Verified against PBKDF2-SHA256 password hashes in the `users` table
3. Cached for `auth_cache_ttl_seconds` (configurable) to avoid repeated hash comparisons

### 7.2 Authorization layers

```
Layer 1: Authentication    — Is the user who they claim to be?
Layer 2: Team membership   — Is the user a member of the requested team?
Layer 3: Role check        — Is the user an admin (global or team)?
Layer 4: Resource ACL      — Does the user have the right permission on this specific resource?
```

Layers 3 and 4 are only reached if Layer 2 passes. Global admins (`is_admin=True`) bypass Layers 3 and 4.

### 7.3 Permission levels (resource ACL)

| Level | Read | Log runs | Modify metadata | Delete | Manage access |
|-------|------|----------|-----------------|--------|---------------|
| READ | ✅ | ❌ | ❌ | ❌ | ❌ |
| USE | ✅ | ✅ | ❌ | ❌ | ❌ |
| EDIT | ✅ | ✅ | ✅ | ❌ | ❌ |
| MANAGE | ✅ | ✅ | ✅ | ✅ | ✅ |

Default permission (set in `basic_auth.ini`): `READ` — all team members can see all team experiments by default. Individual experiments or models can be restricted further via explicit grants.

### 7.4 Model visibility

| Visibility | Who can see |
|-----------|------------|
| `team` (default) | Only members of the owning team |
| `public` | Any authenticated user regardless of team |

Public models are read-only for non-owning teams. Only the model owner (MANAGE permission) or a team admin can change visibility.

### 7.5 Home tenant privacy

Each user's home tenant (`<username>`) is created with only that user as admin. No one else is a member by default, so:
- `/api/2.0/mlflow/experiments/search` with `X-MLflow-Tenant: alice` returns 403 for anyone other than `alice` or a global admin
- `alice` must explicitly call `POST /api/3.0/mlflow/teams/members/add` to share their home workspace

---

## 8. Deployment Guide

### 8.1 Prerequisites

```bash
pip install mlflow[auth]   # Flask-WTF, werkzeug, etc.
```

### 8.2 Configuration file (`basic_auth.ini`)

```ini
[mlflow]
default_permission = READ
database_uri = sqlite:////path/to/auth.db
admin_username = admin
admin_password = <strong-password-min-12-chars>
authorization_function = mlflow.server.auth:authenticate_request_basic_auth
grant_default_workspace_access = false
```

### 8.3 Starting the server

```bash
PYTHONPATH=/path/to/mlflow-multi-users \
MLFLOW_AUTH_CONFIG_PATH=/path/to/basic_auth.ini \
MLFLOW_FLASK_SERVER_SECRET_KEY=<strong-random-key> \
python3 -m mlflow server \
  --host 0.0.0.0 \
  --port 5005 \
  --app-name basic-auth \
  --backend-store-uri sqlite:////path/to/tracking.db \
  --artifacts-destination /path/to/artifacts \
  --serve-artifacts
```

### 8.4 Artifact storage for HPC (ALCF Eagle)

| Server location | Recommended `artifacts-destination` |
|----------------|-------------------------------------|
| ALCF login node | `/eagle/<project>/mlflow` |
| Local laptop with SSHFS | `/eagle/<project>/mlflow` (after mounting) |
| Remote VM without Eagle | `/tmp/artifacts` (sync with Globus periodically) |

Per-team artifact roots can be set in the Teams tab: e.g. `/eagle/datascience/mlflow` for the datascience team so their experiments' artifacts land in their Eagle allocation.

### 8.5 Logging experiments from Python (patching the SDK)

```python
import requests, os, base64

# Inject X-MLflow-Tenant header into all requests
_ORIG = requests.Session.send
def _with_team(self, r, **kw):
    r.headers["X-MLflow-Tenant"] = "datascience"  # your team slug
    return _ORIG(self, r, **kw)
requests.Session.send = _with_team

os.environ["MLFLOW_TRACKING_USERNAME"] = "userA"
os.environ["MLFLOW_TRACKING_PASSWORD"] = "UserA@Pass123!"

import mlflow
mlflow.set_tracking_uri("http://your-server:5005")
mlflow.set_experiment("DLIO")

with mlflow.start_run(run_name="my-experiment"):
    mlflow.log_param("lr", 0.001)
    mlflow.log_metric("accuracy", 0.963)
    mlflow.sklearn.log_model(model, "model",
                             registered_model_name="my-model")
```

---

## 9. User Guide

### 9.1 Logging in

1. Navigate to `http://your-server:5005`
2. You will be redirected to the **Sign in** page automatically
3. Enter your username and password
4. Click **Sign in** — you are taken to your default team's experiments

> **First login:** Your admin will create your account. Your initial password will be communicated to you by the admin. Change it immediately via Profile → Change Password.

### 9.2 Switching teams

Your teams appear in the **team switcher dropdown** in the top of the sidebar, below the MLflow logo.

```
Team
[Data Science ★          ▼]
   Data Science ★
   userA (home)
   Performance Engineering
```

- **★** marks teams where you are an admin
- Click a team name to switch — the experiments list updates immediately
- No re-login is required

### 9.3 Your home workspace

Every user has a private workspace named after their username. It works like `/home/<user>` on an HPC system:

- **Only you can access it** by default
- You can invite collaborators: Admin → Users → Team Members (while in your home team)
- Perfect for personal experiments and staging work before sharing with the team

### 9.4 Running experiments

#### From the UI
1. Switch to your team (or home workspace)
2. Click **+ New Experiment** to create a project
3. Use the standard MLflow experiment view to browse runs

#### From Python
```python
# Set team context once at the top of your script
import requests, os
_ORIG = requests.Session.send
def _patch(self, r, **kw):
    r.headers["X-MLflow-Tenant"] = "datascience"  # ← your team
    return _ORIG(self, r, **kw)
requests.Session.send = _patch

os.environ["MLFLOW_TRACKING_USERNAME"] = "userA"
os.environ["MLFLOW_TRACKING_PASSWORD"] = "your-password"

import mlflow
mlflow.set_tracking_uri("http://server:5005")
mlflow.set_experiment("my-project")

with mlflow.start_run():
    mlflow.log_params({"lr": 0.001, "epochs": 10})
    mlflow.log_metrics({"accuracy": 0.963, "loss": 0.12})
    mlflow.sklearn.log_model(model, "model")
```

### 9.5 Registering models

#### From Python (automatic on run)
```python
mlflow.sklearn.log_model(
    model,
    artifact_path="model",
    registered_model_name="fraud-classifier",  # registers automatically
)
```

#### From the UI
1. Open any run → scroll to **Artifacts** → click the `model` folder
2. Click **Register Model** → enter or select a model name

#### Model visibility
By default, registered models are **team-private** — only your team members can see them. To share publicly:
- Admin panel → **Models** tab → click **Make public** on any model

Public models are readable by all authenticated users in any team, but only the owning team can modify them.

### 9.6 Profile page

Click your username/avatar in the bottom of the sidebar → **Profile**

You can update:
- **Photo**: Click "Upload photo" → select any image → auto-cropped to 128×128
- **Display name**, **Email**, **Title**, **Department**, **Location**
- **Bio** (short description)
- **GitHub** handle, **ORCID** identifier

Your profile also shows all teams you belong to and your role in each.

### 9.7 Changing your password

Profile page → **Change Password** button (Basic Auth deployments only).

### 9.8 Logging out

Sidebar → click your avatar → **Log out**.

This clears the auth cookie. You will be redirected to the login page.

---

## 10. Administrator Guide

### 10.1 Admin levels

| Type | How set | What they can do |
|------|---------|-----------------|
| **Global admin** | `users.is_admin = True` (set via Admin → Users → Global Admins section) | Everything: all teams, all experiments, create/delete tenants, promote/demote users |
| **Team admin** | `team_memberships.role = 'admin'` (set when adding a user with role=admin) | Manage members and projects within their team only |
| **Regular member** | `team_memberships.role = 'member'` | Log runs, view experiments, manage their own home workspace |

### 10.2 Admin panel navigation

Navigate to **Admin** via the gear icon in the sidebar or by clicking your avatar → **Manage**.

The panel has five tabs:

| Tab | Who can access | Purpose |
|-----|---------------|---------|
| **Users** | Global + team admins | Create/delete users, manage team membership, set global admin |
| **Teams** | Global admin only | Create/edit/delete teams |
| **Projects** | Global + team admins | Create/rename/delete experiments, manage access per project |
| **Models** | Global + team admins | Set model visibility (team vs. public) |
| **Roles** | Global + team admins | Manage RBAC roles (advanced) |

### 10.3 Creating a new team

1. Admin panel → **Teams** tab
2. Click **Create Team**
3. Fill in:
   - **Team name**: Human-readable name (e.g. "Data Science")
   - **Slug**: URL-safe identifier, auto-sanitised to `[a-z0-9-]` (e.g. `data-science`)
   - **Artifact storage root** *(optional)*: File path for team artifacts (e.g. `/eagle/datascience/mlflow`)
4. Click **Create**

The slug becomes the value sent in `X-MLflow-Tenant` header. It cannot be changed after creation (it is the primary key).

**Artifact storage root:** Where MLflow stores model files and artifacts for this team. Leave blank to use the server default. For ALCF, set this to the team's Eagle allocation path.

### 10.4 Adding users to a team

**Option A — From the Users tab (while in the team's context):**
1. Switch to the team using the sidebar team switcher
2. Admin panel → **Users** tab → **Team Members** section
3. Type the username, select role (admin/member), click **Add member**

**Option B — When creating a user:**
```bash
curl -u admin:admin1234567 \
  -X POST http://server:5005/api/2.0/mlflow/users/create \
  -H "Content-Type: application/json" \
  -H "X-MLflow-Tenant: datascience" \
  -d '{"username":"alice","password":"Alice@Secure123!","role":"admin"}'
```

> **Note for global admins:** Use the team switcher to switch to the target team before using the Add member form. A hint appears reminding you of this when you're in the default team context.

### 10.5 Creating a new user

1. Switch to the team where the user should be created
2. Admin panel → **Users** tab → **Create User** button (or via API)
3. The user automatically receives:
   - Membership in the selected team with the specified role
   - A **private home workspace** named `<username>` — only they have access

**Password requirements:** Minimum 12 characters (enforced server-side by `_validate_password`).

### 10.6 Promoting a user to global admin

Only global admins can promote others to global admin.

1. Admin panel → **Users** tab → **Global Admins** section
2. Find the user in the table
3. Click **Make Global Admin**

To demote: click **Revoke** on the same row.

> **Warning:** Global admins bypass all team isolation. Use sparingly — typically one or two system administrators per deployment.

### 10.7 Managing project access

Each experiment (project) can have per-user permission grants independent of team membership.

1. Admin panel → **Projects** tab
2. Click **Manage access** on any project
3. In the modal:
   - **Grant access**: select user, select permission (READ/USE/EDIT/MANAGE), click Grant
   - **Current access table**: shows all users with existing grants; Edit or Revoke per row

**Permission levels:**
- `READ` — view experiment and runs
- `USE` — log new runs
- `EDIT` — modify experiment metadata
- `MANAGE` — full control including renaming and deleting

The default team permission (`READ` from `basic_auth.ini`) applies to all team members for experiments without explicit grants.

### 10.8 Setting model visibility

1. Admin panel → **Models** tab
2. Click **Make public** to share a model with all authenticated users across all teams
3. Click **Make private** to restrict it back to the owning team

### 10.9 Editing a team

1. Admin panel → **Teams** tab
2. Click **Edit** on any team row
3. Update the **name** and/or **artifact storage root** (slug is read-only)
4. Click **Save**

### 10.10 Deleting a team

1. Admin panel → **Teams** tab → **Delete** on the target team
2. The `default` system team cannot be deleted

> **Warning:** Deleting a team does not delete the experiments and runs inside it from the tracking database. They become orphaned (tenant slug no longer exists, so they are inaccessible via the API). Clean up experiments before deleting a team, or adjust the tenant slug in the database directly.

### 10.11 Backup and recovery

Two database files need regular backup:

```bash
# Auth DB (users, teams, permissions)
cp /path/to/auth.db /backup/auth-$(date +%Y%m%d).db

# Tracking DB (experiments, runs, metrics)
cp /path/to/tracking.db /backup/tracking-$(date +%Y%m%d).db
```

Artifact files live at `--artifacts-destination` and should be backed up separately (e.g. Globus transfer to tape).

### 10.12 API quick reference for admins

```bash
BASE="http://server:5005"
ADMIN="admin:admin1234567"

# Create team
curl -su "$ADMIN" -X POST "$BASE/api/3.0/mlflow/tenants/create" \
  -H "Content-Type: application/json" \
  -d '{"slug":"team-slug","name":"Team Name","storage_root":"/eagle/team/mlflow"}'

# Add user to team
curl -su "$ADMIN" -X POST "$BASE/api/3.0/mlflow/teams/members/add" \
  -H "Content-Type: application/json" -H "X-MLflow-Tenant: team-slug" \
  -d '{"username":"alice","role":"member"}'

# Promote user to global admin
curl -su "$ADMIN" -X PATCH "$BASE/api/2.0/mlflow/users/update-admin" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","is_admin":true}'

# List all teams
curl -su "$ADMIN" "$BASE/api/3.0/mlflow/tenants/list"

# Make a model public
curl -su "$ADMIN" -X POST "$BASE/ajax-api/2.0/mlflow/registered-models/set-visibility" \
  -H "Content-Type: application/json" -H "X-MLflow-Tenant: team-slug" \
  -d '{"name":"my-model","visibility":"public"}'
```

---

## 11. Design Decisions & Trade-offs

### 11.1 Why W&B entity switcher instead of merged view?

W&B uses a **switcher view**: one team at a time, switched via a dropdown. The alternative (merged view, like Gmail showing all accounts together) would require `WHERE tenant IN (all your teams)` across every query, making the data model significantly more complex (e.g. what happens when two teams have experiments with the same name?). The switcher model keeps query complexity constant and matches the mental model of HPC project allocation switching (`newgrp`).

### 11.2 Why application-layer isolation instead of separate databases?

**Separate databases** (one per team) provide stronger isolation guarantees. However, they require:
- N migration runs (one per team) when the schema changes
- N backup jobs
- A process router to direct traffic to the right database

For a research computing environment with O(10–100) teams, shared-table isolation with SQL `WHERE` clauses is operationally simpler and sufficient. The risk is a query bug leaking data across teams — mitigated by the multi-layer test coverage in `tests/server/auth/test_multi_tenant.py`.

### 11.3 Why ContextVar instead of request-thread-local?

Python's `contextvars.ContextVar` works correctly with both synchronous (threaded Flask) and asynchronous (uvicorn/asyncio) request handling. `threading.local()` would work for Flask but would fail in the async FastAPI middleware that MLflow also uses. ContextVar is the modern Python standard for request-scoped state.

### 11.4 Why base64 avatars instead of file upload?

Storing avatars as base64 data URLs in the `users.avatar_url` column avoids the complexity of a file server and artifact path management. At 128×128 JPEG (quality 85), a typical avatar is 8–15 KB base64-encoded. For a deployment with 1000 users, this adds ~15 MB to the auth database — acceptable for SQLite or PostgreSQL.

### 11.5 Why keep `is_admin` as a global flag instead of per-team-only?

A single system superuser account (`admin`) with `is_admin=True` is necessary for:
1. Initial bootstrap (no team context exists yet)
2. Accessing all teams without needing membership rows in every team
3. Emergency access when all team admins are unavailable

Regular team admins use `team_memberships.role = 'admin'`, which is scoped to one team. The two-level design (global admin + team admin) maps directly to the HPC distinction between facility administrators and project PIs.

---

## 12. Known Limitations & Future Work

### 12.1 Current limitations

| Limitation | Impact | Potential fix |
|-----------|--------|--------------|
| SQLite not suitable for production scale | Single-writer, limited concurrency | Use PostgreSQL (drop-in replacement via SQLAlchemy) |
| Application-layer tenant isolation | Bugs could leak cross-team data | Add integration tests; consider separate DBs for sensitive deployments |
| No email notifications | Admin must communicate credentials out-of-band | Add SMTP integration |
| No SSO / SAML / OAuth | Users must be created manually | Integrate with LDAP/AD or OAuth2 provider |
| Tenant deletion orphans data | Experiments remain in tracking DB with inaccessible tenant | Add cascade delete or data migration tool |
| Avatar stored as base64 in DB | Large if many users with photos | Move to artifact store |
| `X-MLflow-Tenant` header must be set manually for Python SDK | Requires patching `requests.Session.send` | Contribute `MLFLOW_TRACKING_TEAM` env var to upstream MLflow |

### 12.2 Future work

1. **Resource quotas enforcement**: `max_experiments` and `max_users` fields exist in the `tenants` table but are not yet enforced at insert time.
2. **Team invitations via email**: admin creates an invitation link; user clicks to join and set password.
3. **Cross-team experiment sharing**: share a specific experiment with another team without making it fully public.
4. **Globus-native artifact store**: route artifact uploads/downloads through Globus Transfer for Eagle/HPSS integration.
5. **Upstream contribution**: submit the `tenant_context.py` + tracking store tenant filtering as a PR to `mlflow/mlflow` under the `workspaces` feature flag.
6. **Kubernetes deployment**: Helm chart with PostgreSQL backend, separate auth and tracking databases, and horizontal scaling.

---

*End of document*

**Repository:** https://github.com/zhenghh04/mlflow/tree/multi-tenant  
**Contact:** huihuo.zheng@anl.gov  
**License:** Apache 2.0 (same as upstream MLflow)
