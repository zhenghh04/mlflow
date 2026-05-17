"""Add multi-tenant support: tenants table, tenant_id FKs on users and roles

Revision ID: a9b0c1d2e3f4
Revises: f1a2b3c4d5e6
Create Date: 2026-05-16 00:00:00.000000

Migration strategy:
1. Create ``tenants`` table with a seed "default" row.
2. Add nullable ``tenant_id`` columns to ``users`` and ``roles``.
3. Backfill all existing rows to the default tenant.
4. Make ``tenant_id`` NOT NULL and add FK + unique constraints.
5. Drop the old ``users.username`` unique constraint (now scoped per tenant).
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Boolean, Column, ForeignKey, Integer, MetaData, String, Table, UniqueConstraint

revision = "a9b0c1d2e3f4"
down_revision = "f1a2b3c4d5e6"
branch_labels = None
depends_on = None

_DEFAULT_SLUG = "default"
_DEFAULT_NAME = "Default Tenant"


def upgrade() -> None:
    bind = op.get_bind()

    # 1. Create tenants table
    tenants_table = op.create_table(
        "tenants",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("slug", sa.String(length=63), unique=True, nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("storage_root", sa.String(length=1024), nullable=True),
        sa.Column("max_experiments", sa.BigInteger(), nullable=True),
        sa.Column("max_users", sa.BigInteger(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # 2. Seed the default tenant and capture its id
    result = bind.execute(
        tenants_table.insert().values(slug=_DEFAULT_SLUG, name=_DEFAULT_NAME).returning(
            tenants_table.c.id
        )
    )
    default_tenant_id = result.scalar()

    # 3. Add tenant_id to users.
    # Use copy_from to provide the target schema explicitly so that the old
    # column-level UNIQUE on ``username`` (no name in SQLite) is not carried
    # forward into the new table. The new composite UNIQUE (tenant_id, username)
    # replaces it.
    op.add_column("users", sa.Column("tenant_id", sa.Integer(), nullable=True))
    bind.execute(
        sa.text("UPDATE users SET tenant_id = :tid").bindparams(tid=default_tenant_id)
    )
    users_new = Table(
        "users",
        MetaData(),
        Column("id", Integer(), primary_key=True),
        Column("username", String(255), nullable=True),
        Column("password_hash", String(255), nullable=True),
        Column("is_admin", Boolean(), default=False),
        Column("tenant_id", Integer(), ForeignKey("tenants.id"), nullable=False),
        UniqueConstraint("tenant_id", "username", name="unique_tenant_username"),
    )
    with op.batch_alter_table("users", copy_from=users_new, recreate="always") as batch_op:
        pass  # schema fully expressed in copy_from; no incremental ops needed
    op.create_index("idx_users_tenant_id", "users", ["tenant_id"])

    # 4. Add tenant_id to roles.
    op.add_column("roles", sa.Column("tenant_id", sa.Integer(), nullable=True))
    bind.execute(
        sa.text("UPDATE roles SET tenant_id = :tid").bindparams(tid=default_tenant_id)
    )
    roles_new = Table(
        "roles",
        MetaData(),
        Column("id", Integer(), primary_key=True),
        Column("name", String(255), nullable=False),
        Column("workspace", String(63), nullable=False),
        Column("description", String(1024), nullable=True),
        Column("tenant_id", Integer(), ForeignKey("tenants.id"), nullable=False),
        UniqueConstraint("tenant_id", "workspace", "name", name="unique_tenant_workspace_role_name"),
    )
    with op.batch_alter_table("roles", copy_from=roles_new, recreate="always") as batch_op:
        pass
    op.create_index("idx_roles_tenant_id", "roles", ["tenant_id"])


def downgrade() -> None:
    # Roles
    op.drop_index("idx_roles_tenant_id", table_name="roles")
    op.drop_constraint("unique_tenant_workspace_role_name", "roles", type_="unique")
    op.create_unique_constraint("unique_workspace_role_name", "roles", ["workspace", "name"])
    op.drop_constraint("fk_roles_tenant_id", "roles", type_="foreignkey")
    op.drop_column("roles", "tenant_id")

    # Users
    op.drop_index("idx_users_tenant_id", table_name="users")
    op.drop_constraint("unique_tenant_username", "users", type_="unique")
    op.create_unique_constraint("users_username_key", "users", ["username"])
    op.drop_constraint("fk_users_tenant_id", "users", type_="foreignkey")
    op.drop_column("users", "tenant_id")

    # Tenants
    op.drop_table("tenants")
