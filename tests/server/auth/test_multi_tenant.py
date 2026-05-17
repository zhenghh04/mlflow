"""Tests for multi-tenant MLflow: tenant CRUD, isolation, context propagation."""

from __future__ import annotations

import pytest

from mlflow.tenant_context import (
    DEFAULT_TENANT_SLUG,
    get_active_tenant_slug,
    reset_active_tenant_slug,
    resolve_tenant_slug,
    set_active_tenant_slug,
)



# ---------------------------------------------------------------------------
# TenantContext unit tests
# ---------------------------------------------------------------------------


def test_default_tenant_slug():
    assert get_active_tenant_slug() == DEFAULT_TENANT_SLUG


def test_set_and_reset_tenant_slug():
    token = set_active_tenant_slug("acme")
    assert get_active_tenant_slug() == "acme"
    reset_active_tenant_slug(token)
    assert get_active_tenant_slug() == DEFAULT_TENANT_SLUG


def test_set_tenant_slug_is_scoped(monkeypatch):
    # Each thread / context var scope is independent.
    import threading

    results = {}

    def worker():
        token = set_active_tenant_slug("worker-tenant")
        results["inside"] = get_active_tenant_slug()
        reset_active_tenant_slug(token)
        results["after"] = get_active_tenant_slug()

    t = threading.Thread(target=worker)
    t.start()
    t.join()
    assert results["inside"] == "worker-tenant"
    assert results["after"] == DEFAULT_TENANT_SLUG


@pytest.mark.parametrize(
    ("headers", "expected"),
    [
        ({"X-MLflow-Tenant": "acme"}, "acme"),
        ({"Host": "acme.mlflow.example.com"}, "acme"),
        ({"Host": "mlflow.example.com"}, DEFAULT_TENANT_SLUG),  # only 3 parts — not a tenant subdomain
        ({}, DEFAULT_TENANT_SLUG),
        ({"X-MLflow-Tenant": "  "}, DEFAULT_TENANT_SLUG),
    ],
)
def test_resolve_tenant_slug(headers, expected):
    assert resolve_tenant_slug(headers) == expected


def test_resolve_tenant_slug_header_takes_priority_over_host():
    headers = {"X-MLflow-Tenant": "from-header", "Host": "from-host.mlflow.example.com"}
    assert resolve_tenant_slug(headers) == "from-header"


# ---------------------------------------------------------------------------
# SqlAlchemyStore tenant CRUD (integration — SQLite in-memory)
# ---------------------------------------------------------------------------


@pytest.fixture
def auth_store(tmp_path):
    """A fresh SqlAlchemyStore backed by a temporary SQLite DB."""
    from mlflow.server.auth.sqlalchemy_store import SqlAlchemyStore

    db_path = tmp_path / "auth.db"
    store = SqlAlchemyStore()
    store.init_db(f"sqlite:///{db_path}")
    return store


def _with_tenant(slug: str):
    """Context manager that sets the active tenant for the duration of a block."""
    import contextlib

    @contextlib.contextmanager
    def _ctx():
        token = set_active_tenant_slug(slug)
        try:
            yield
        finally:
            reset_active_tenant_slug(token)

    return _ctx()


def test_create_and_get_tenant(auth_store):
    tenant = auth_store.create_tenant(slug="acme", name="Acme Corp")
    assert tenant.slug == "acme"
    assert tenant.name == "Acme Corp"
    assert tenant.storage_root is None

    fetched = auth_store.get_tenant("acme")
    assert fetched.slug == "acme"
    assert fetched.id == tenant.id


def test_list_tenants_includes_default_and_new(auth_store):
    auth_store.get_or_create_default_tenant()
    auth_store.create_tenant(slug="beta", name="Beta Inc")
    slugs = {t.slug for t in auth_store.list_tenants()}
    assert DEFAULT_TENANT_SLUG in slugs
    assert "beta" in slugs


def test_update_tenant(auth_store):
    auth_store.create_tenant(slug="gamma", name="Gamma")
    updated = auth_store.update_tenant(
        "gamma", name="Gamma 2.0", storage_root="s3://gamma-bucket/mlflow"
    )
    assert updated.name == "Gamma 2.0"
    assert updated.storage_root == "s3://gamma-bucket/mlflow"


def test_delete_tenant(auth_store):
    auth_store.create_tenant(slug="tmp-tenant", name="Tmp")
    auth_store.delete_tenant("tmp-tenant")
    from mlflow.exceptions import MlflowException

    with pytest.raises(MlflowException, match="not found"):
        auth_store.get_tenant("tmp-tenant")


def test_cannot_delete_default_tenant(auth_store):
    auth_store.get_or_create_default_tenant()
    from mlflow.exceptions import MlflowException

    with pytest.raises(MlflowException, match="default tenant cannot be deleted"):
        auth_store.delete_tenant(DEFAULT_TENANT_SLUG)


def test_duplicate_tenant_slug_raises(auth_store):
    auth_store.create_tenant(slug="dup", name="Dup")
    from mlflow.exceptions import MlflowException

    with pytest.raises(MlflowException, match="already exists"):
        auth_store.create_tenant(slug="dup", name="Dup 2")


# ---------------------------------------------------------------------------
# User isolation across tenants
# ---------------------------------------------------------------------------


def test_users_isolated_across_tenants(auth_store):
    auth_store.create_tenant(slug="t1", name="Tenant 1")
    auth_store.create_tenant(slug="t2", name="Tenant 2")

    with _with_tenant("t1"):
        auth_store.create_user("alice", "password1")

    with _with_tenant("t2"):
        auth_store.create_user("alice", "password2")  # same username, different tenant
        users_t2 = auth_store.list_users()
        assert any(u.username == "alice" for u in users_t2)

    with _with_tenant("t1"):
        users_t1 = auth_store.list_users()
        assert len(users_t1) == 1
        assert users_t1[0].username == "alice"

    # alice in t1 and alice in t2 should be separate rows
    with _with_tenant("t1"):
        assert auth_store.authenticate_user("alice", "password1")
        assert not auth_store.authenticate_user("alice", "password2")

    with _with_tenant("t2"):
        assert auth_store.authenticate_user("alice", "password2")
        assert not auth_store.authenticate_user("alice", "password1")


def test_list_users_returns_only_active_tenant(auth_store):
    auth_store.create_tenant(slug="ta", name="TA")
    auth_store.create_tenant(slug="tb", name="TB")

    with _with_tenant("ta"):
        auth_store.create_user("bob", "pw")

    with _with_tenant("tb"):
        users = auth_store.list_users()
        assert not any(u.username == "bob" for u in users)


# ---------------------------------------------------------------------------
# Tracking store experiment isolation
# ---------------------------------------------------------------------------


@pytest.fixture
def tracking_store(tmp_path):
    """A SqlAlchemyTrackingStore backed by a temporary SQLite DB."""
    from mlflow.store.tracking.sqlalchemy_store import SqlAlchemyStore

    db_uri = f"sqlite:///{tmp_path / 'tracking.db'}"
    artifact_root = str(tmp_path / "artifacts")
    store = SqlAlchemyStore(db_uri, artifact_root)
    return store


def test_experiment_isolation_across_tenants(tracking_store):
    with _with_tenant("tenant-a"):
        exp_id_a = tracking_store.create_experiment("shared-name")

    with _with_tenant("tenant-b"):
        exp_id_b = tracking_store.create_experiment("shared-name")  # same name, different tenant

    assert exp_id_a != exp_id_b

    with _with_tenant("tenant-a"):
        exps_a = tracking_store.search_experiments()
        names_a = {e.name for e in exps_a}

    with _with_tenant("tenant-b"):
        exps_b = tracking_store.search_experiments()
        names_b = {e.name for e in exps_b}

    assert "shared-name" in names_a
    assert "shared-name" in names_b

    # Neither tenant should see the other's experiment by its ID
    with _with_tenant("tenant-a"):
        from mlflow.exceptions import MlflowException

        with pytest.raises(MlflowException):
            tracking_store.get_experiment(exp_id_b)


def test_runs_stay_scoped_to_creating_tenant(tracking_store):
    import time

    with _with_tenant("ta"):
        exp_id = tracking_store.create_experiment("ta-experiment")
        run = tracking_store.create_run(
            experiment_id=exp_id,
            user_id="u1",
            start_time=int(time.time() * 1000),
            tags=[],
            run_name="run1",
        )

    with _with_tenant("tb"):
        # tenant-b cannot see tenant-a's experiment, so searching returns no runs
        exps_tb = tracking_store.search_experiments()
        exp_ids_tb = [e.experiment_id for e in exps_tb]
        assert exp_id not in exp_ids_tb

    # tenant-a can still retrieve the run directly
    with _with_tenant("ta"):
        fetched = tracking_store.get_run(run.info.run_id)
        assert fetched.info.run_id == run.info.run_id
