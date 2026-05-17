"""Add visibility column to registered_models ('team' | 'public')

Revision ID: d3e4f5a6b7c8
Revises: c2d3e4f5a6b7
Create Date: 2026-05-17 00:00:00.000000

'team'   (default) — only members of the owning tenant can see the model.
'public' — any authenticated user across all teams can read it.
"""

import sqlalchemy as sa
from alembic import op

revision = "fa1b2c3d4e5f"
# Merge the tenant-registered-models migration with the pre-existing
# budget-policies head so Alembic has a single clean head.
down_revision = ("c2d3e4f5a6b7", "e1f2a3b4c5d6")
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    op.add_column(
        "registered_models",
        sa.Column(
            "visibility",
            sa.String(length=16),
            nullable=True,
            server_default=sa.text("'team'"),
        ),
    )
    bind.execute(sa.text("UPDATE registered_models SET visibility = 'team' WHERE visibility IS NULL"))
    with op.batch_alter_table("registered_models", recreate="always") as batch_op:
        batch_op.alter_column("visibility", nullable=False)
    op.create_index("idx_registered_models_visibility", "registered_models", ["visibility"])


def downgrade() -> None:
    op.drop_index("idx_registered_models_visibility", table_name="registered_models")
    op.drop_column("registered_models", "visibility")
