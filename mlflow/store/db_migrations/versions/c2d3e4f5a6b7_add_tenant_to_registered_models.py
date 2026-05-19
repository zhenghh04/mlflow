"""Add tenant column to registered_models for multi-tenant isolation

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6
Create Date: 2026-05-16 00:00:01.000000
"""

import sqlalchemy as sa
from alembic import op

revision = "c2d3e4f5a6b7"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None

_DEFAULT_TENANT = "default"


def upgrade() -> None:
    bind = op.get_bind()

    op.add_column(
        "registered_models",
        sa.Column(
            "tenant",
            sa.String(length=63),
            nullable=True,
            server_default=sa.text(f"'{_DEFAULT_TENANT}'"),
        ),
    )
    bind.execute(
        sa.text(
            f"UPDATE registered_models SET tenant = '{_DEFAULT_TENANT}' WHERE tenant IS NULL"
        )
    )
    with op.batch_alter_table("registered_models", recreate="always") as batch_op:
        batch_op.alter_column("tenant", nullable=False)
        batch_op.create_unique_constraint(
            "uq_registered_models_tenant", ["tenant", "workspace", "name"]
        )
    op.create_index("idx_registered_models_tenant", "registered_models", ["tenant"])


def downgrade() -> None:
    op.drop_index("idx_registered_models_tenant", table_name="registered_models")
    op.drop_constraint("uq_registered_models_tenant", "registered_models", type_="unique")
    op.drop_column("registered_models", "tenant")
