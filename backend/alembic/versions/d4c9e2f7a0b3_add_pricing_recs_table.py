"""add_pricing_recs_table

Revision ID: d4c9e2f7a0b3
Revises: 3a7f0c1d9b21
Create Date: 2026-05-03

Stores AI-generated pricing recommendations per category+date.
Refreshed on every analysis run and at 8AM daily.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d4c9e2f7a0b3"
down_revision: Union[str, None] = "3a7f0c1d9b21"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pricing_recs",
        sa.Column("id", sa.String(), nullable=False),                       # {CATEGORY}_{YYYY-MM-DD}
        sa.Column("category", sa.String(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("recommended_action", sa.String(), nullable=False, server_default="MAINTAIN"),
        sa.Column("current_rate", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("recommended_rate", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("change_pct", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("confidence", sa.String(), nullable=False, server_default="MEDIUM"),
        sa.Column("reasoning", sa.Text(), nullable=False, server_default=""),
        sa.Column("weather_factor", sa.String(), nullable=False, server_default=""),
        sa.Column("event_factor", sa.String(), nullable=False, server_default=""),
        sa.Column("news_factor", sa.String(), nullable=False, server_default=""),
        sa.Column("is_orphan", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("occupancy_pct", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("otb", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("floor_rate", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("computed_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_pricing_recs_category", "pricing_recs", ["category"])
    op.create_index("ix_pricing_recs_date", "pricing_recs", ["date"])


def downgrade() -> None:
    op.drop_index("ix_pricing_recs_date", table_name="pricing_recs")
    op.drop_index("ix_pricing_recs_category", table_name="pricing_recs")
    op.drop_table("pricing_recs")
