"""add_offers_and_slot_offer_id

Revision ID: 3a7f0c1d9b21
Revises: b227ced3351d
Create Date: 2026-04-25

Adds an Offer model to track discounted inventory interventions and links Slots to Offers.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "3a7f0c1d9b21"
down_revision: Union[str, None] = "b227ced3351d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # roomcategory already exists in production (created in initial_schema).
    # When creating a new table that reuses it, we must NOT attempt to create the type again.
    roomcategory_enum = postgresql.ENUM(
        "DELUXE",
        "SUITE",
        "STUDIO",
        "STANDARD",
        "PREMIUM",
        "ECONOMY",
        name="roomcategory",
        create_type=False,
    )

    op.create_table(
        "offers",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column(
            "offer_type",
            postgresql.ENUM("SANDWICH_ORPHAN", "EXTENSION_OFFER", "LAST_MINUTE", name="offertype"),
            nullable=False,
        ),
        sa.Column(
            "category",
            roomcategory_enum,
            nullable=True,
        ),
        sa.Column("offer_date", sa.Date(), nullable=True),
        sa.Column("discount_pct", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("original_rate", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("discounted_rate", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("reason", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    op.add_column("slots", sa.Column("offer_id", sa.String(), nullable=True))
    op.create_foreign_key("fk_slots_offer_id_offers", "slots", "offers", ["offer_id"], ["id"])


def downgrade() -> None:
    op.drop_constraint("fk_slots_offer_id_offers", "slots", type_="foreignkey")
    op.drop_column("slots", "offer_id")
    op.drop_table("offers")
    op.execute("DROP TYPE IF EXISTS offertype")

