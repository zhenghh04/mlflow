"""Add tenant column to experiments table for multi-tenant isolation

Revision ID: b1c2d3e4f5a6
Revises: cbc13b556ace
Create Date: 2026-05-16 00:00:00.000000

Adds a ``tenant`` column (varchar 63, NOT NULL, default ``'default'``) to the
``experiments`` table and replaces the workspace-only unique constraint with a
tenant-scoped one.  All existing rows are backfilled to the ``'default'`` tenant.
"""

import sqlalchemy as sa
from alembic import op

revision = "b1c2d3e4f5a6"
down_revision = ("cbc13b556ace", "da6fb0208061")
branch_labels = None
depends_on = None

_DEFAULT_TENANT = "default"


def upgrade() -> None:
    bind = op.get_bind()

    op.add_column(
        "experiments",
        sa.Column(
            "tenant",
            sa.String(length=63),
            nullable=True,
            server_default=sa.text(f"'{_DEFAULT_TENANT}'"),
        ),
    )
    bind.execute(
        sa.text(f"UPDATE experiments SET tenant = '{_DEFAULT_TENANT}' WHERE tenant IS NULL")
    )
    with op.batch_alter_table("experiments", recreate="always") as batch_op:
        batch_op.alter_column("tenant", nullable=False)
        batch_op.drop_constraint("uq_experiments_workspace_name", type_="unique")
        batch_op.create_unique_constraint(
            "uq_experiments_tenant_workspace_name", ["tenant", "workspace", "name"]
        )
    op.create_index("idx_experiments_tenant", "experiments", ["tenant"])


def downgrade() -> None:
    op.drop_index("idx_experiments_tenant", table_name="experiments")
    op.drop_constraint("uq_experiments_tenant_workspace_name", "experiments", type_="unique")
    op.create_unique_constraint(
        "uq_experiments_workspace_name", "experiments", ["workspace", "name"]
    )
    op.drop_column("experiments", "tenant")
