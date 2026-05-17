"""Add user profile fields: display_name, email, title, department, location, bio, github, orcid, avatar_url

Revision ID: c4d5e6f7a8b9
Revises: b2c3d4e5f6a7
Create Date: 2026-05-17 00:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = "c4d5e6f7a8b9"
down_revision = "b2c3d4e5f6a7"
branch_labels = None
depends_on = None

_PROFILE_COLS = [
    ("display_name", sa.String(255)),
    ("email",        sa.String(255)),
    ("title",        sa.String(255)),
    ("department",   sa.String(255)),
    ("location",     sa.String(255)),
    ("bio",          sa.Text()),
    ("github",       sa.String(255)),
    ("orcid",        sa.String(64)),
    ("avatar_url",   sa.Text()),
]


def upgrade() -> None:
    # Add each profile column individually — safer than batch recreate
    # when multiple workers start concurrently against SQLite.
    bind = op.get_bind()
    existing = {row[1] for row in bind.execute(sa.text("PRAGMA table_info(users)")).fetchall()}
    for col_name, col_type in _PROFILE_COLS:
        if col_name not in existing:
            op.add_column("users", sa.Column(col_name, col_type, nullable=True))


def downgrade() -> None:
    for col_name, _ in _PROFILE_COLS:
        op.drop_column("users", col_name)
