"""Add team_memberships table; make users global (remove tenant_id from users)

Revision ID: b2c3d4e5f6a7
Revises: a9b0c1d2e3f4
Create Date: 2026-05-17 00:00:00.000000

Migration strategy
------------------
1. Create ``team_memberships(id, user_id, tenant_id, role)`` table.
2. Backfill one membership row per existing user from ``users.tenant_id``:
   - Users in non-default tenants become 'admin' if ``is_admin=True``,
     otherwise 'member'.
   - The system-admin user (``admin`` in the default tenant) gets no
     membership row — their ``is_admin`` flag already grants cross-tenant
     access.
3. Set ``is_admin=False`` on the non-default-tenant admins (their admin
   status is now expressed through ``team_memberships.role='admin'``).
4. Drop ``tenant_id`` from ``users`` and restore the global
   ``UNIQUE(username)`` constraint via batch recreate (SQLite-safe).
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Boolean, Column, ForeignKey, Integer, MetaData, String, Table, UniqueConstraint

revision = "b2c3d4e5f6a7"
down_revision = "a9b0c1d2e3f4"
branch_labels = None
depends_on = None

_DEFAULT_SLUG = "default"


def upgrade() -> None:
    bind = op.get_bind()

    # 1. Create team_memberships table
    op.create_table(
        "team_memberships",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False, server_default="member"),
        sa.UniqueConstraint("user_id", "tenant_id", name="uq_team_membership"),
    )
    op.create_index("idx_team_memberships_user_id", "team_memberships", ["user_id"])
    op.create_index("idx_team_memberships_tenant_id", "team_memberships", ["tenant_id"])

    # 2. Backfill: for each user not in the default tenant, create a membership.
    #    Non-default-tenant admins (is_admin=True) get role='admin'.
    default_tenant_id = bind.execute(
        sa.text("SELECT id FROM tenants WHERE slug = :slug").bindparams(slug=_DEFAULT_SLUG)
    ).scalar()

    rows = bind.execute(
        sa.text("SELECT id, is_admin, tenant_id FROM users WHERE tenant_id != :did").bindparams(
            did=default_tenant_id
        )
    ).fetchall()

    for user_id, is_admin, tenant_id in rows:
        role = "admin" if is_admin else "member"
        bind.execute(
            sa.text(
                "INSERT INTO team_memberships (user_id, tenant_id, role) VALUES (:uid, :tid, :role)"
            ).bindparams(uid=user_id, tid=tenant_id, role=role)
        )

    # 3. Clear the is_admin flag on non-default-tenant users — their admin
    #    status is now expressed through team_memberships.role.
    bind.execute(
        sa.text(
            "UPDATE users SET is_admin = 0 WHERE tenant_id != :did AND is_admin = 1"
        ).bindparams(did=default_tenant_id)
    )

    # 4. Recreate the users table without tenant_id (SQLite-safe batch alter).
    #    ``reflect_args`` suppresses the existing constraints so we can redefine
    #    them cleanly; the FK references from legacy permission tables stay in
    #    place because they reference users.id which doesn't change.
    users_new = Table(
        "users",
        MetaData(),
        Column("id", Integer(), primary_key=True),
        Column("username", String(255), nullable=False),
        Column("password_hash", String(255), nullable=True),
        Column("is_admin", Boolean(), default=False),
        UniqueConstraint("username", name="uq_users_username"),
    )
    with op.batch_alter_table(
        "users",
        copy_from=users_new,
        recreate="always",
        reflect_args=[],
    ) as _batch_op:
        pass


def downgrade() -> None:
    bind = op.get_bind()

    default_tenant_id = bind.execute(
        sa.text("SELECT id FROM tenants WHERE slug = :slug").bindparams(slug=_DEFAULT_SLUG)
    ).scalar()

    # Restore tenant_id on users from the first membership (best-effort)
    op.add_column("users", sa.Column("tenant_id", sa.Integer(), nullable=True))
    bind.execute(
        sa.text("UPDATE users SET tenant_id = :did").bindparams(did=default_tenant_id)
    )
    rows = bind.execute(
        sa.text("SELECT DISTINCT user_id, tenant_id FROM team_memberships")
    ).fetchall()
    for user_id, tenant_id in rows:
        bind.execute(
            sa.text("UPDATE users SET tenant_id = :tid WHERE id = :uid").bindparams(
                tid=tenant_id, uid=user_id
            )
        )

    with op.batch_alter_table("users", recreate="always") as batch_op:
        batch_op.alter_column("tenant_id", nullable=False)
        batch_op.create_foreign_key("fk_users_tenant_id", "tenants", ["tenant_id"], ["id"])
        batch_op.drop_constraint("uq_users_username", type_="unique")
        batch_op.create_unique_constraint("unique_tenant_username", ["tenant_id", "username"])

    op.drop_index("idx_team_memberships_tenant_id", table_name="team_memberships")
    op.drop_index("idx_team_memberships_user_id", table_name="team_memberships")
    op.drop_table("team_memberships")
