"""add_hot_path_indexes

Revision ID: 8c12f4a9d6e0
Revises: d4c9e2f7a0b3
Create Date: 2026-05-30

Adds indexes used by heatmap, booking overlap, commit, pricing, and analytics queries.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "8c12f4a9d6e0"
down_revision: Union[str, None] = "d4c9e2f7a0b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index("ix_slots_date", "slots", ["date"])
    op.create_index("ix_slots_room_id_date", "slots", ["room_id", "date"])
    op.create_index("ix_slots_booking_id", "slots", ["booking_id"])
    op.create_index("ix_slots_block_type", "slots", ["block_type"])
    op.create_index("ix_bookings_created_at", "bookings", ["created_at"])
    op.create_index("ix_bookings_check_in_check_out", "bookings", ["check_in", "check_out"])
    op.create_index("ix_bookings_room_category", "bookings", ["room_category"])


def downgrade() -> None:
    op.drop_index("ix_bookings_room_category", table_name="bookings")
    op.drop_index("ix_bookings_check_in_check_out", table_name="bookings")
    op.drop_index("ix_bookings_created_at", table_name="bookings")
    op.drop_index("ix_slots_block_type", table_name="slots")
    op.drop_index("ix_slots_booking_id", table_name="slots")
    op.drop_index("ix_slots_room_id_date", table_name="slots")
    op.drop_index("ix_slots_date", table_name="slots")
