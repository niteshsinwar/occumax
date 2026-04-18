"""initial_schema

Revision ID: f1a134d3b52e
Revises:
Create Date: 2026-04-18

Baseline migration — represents the current production schema.
Existing databases are stamped at this revision (skips running upgrade).
Fresh databases will have all tables created by running this migration.
"""
from typing import Sequence, Union
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

revision: str = 'f1a134d3b52e'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'rooms',
        sa.Column('id', sa.String(), nullable=False),
        sa.Column('category', sa.Enum('DELUXE', 'SUITE', 'STUDIO', 'STANDARD', 'PREMIUM', 'ECONOMY', name='roomcategory'), nullable=False),
        sa.Column('base_rate', sa.Float(), nullable=False),
        sa.Column('floor_number', sa.Integer(), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default='true'),
        sa.PrimaryKeyConstraint('id'),
    )

    op.create_table(
        'bookings',
        sa.Column('id', sa.String(), nullable=False),
        sa.Column('guest_name', sa.String(), nullable=False),
        sa.Column('guest_id', sa.String(), nullable=False),
        sa.Column('room_category', sa.Enum('DELUXE', 'SUITE', 'STUDIO', 'STANDARD', 'PREMIUM', 'ECONOMY', name='roomcategory'), nullable=False),
        sa.Column('assigned_room_id', sa.String(), sa.ForeignKey('rooms.id'), nullable=True),
        sa.Column('check_in', sa.Date(), nullable=False),
        sa.Column('check_out', sa.Date(), nullable=False),
        sa.Column('is_live', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('stay_group_id', sa.String(), nullable=True),
        sa.Column('segment_index', sa.Integer(), nullable=True),
        sa.Column('discount_pct', sa.Float(), nullable=False, server_default='0.0'),
        sa.PrimaryKeyConstraint('id'),
    )

    op.create_table(
        'slots',
        sa.Column('id', sa.String(), nullable=False),
        sa.Column('room_id', sa.String(), sa.ForeignKey('rooms.id'), nullable=False),
        sa.Column('date', sa.Date(), nullable=False),
        sa.Column('block_type', sa.Enum('HARD', 'SOFT', 'EMPTY', name='blocktype'), nullable=False),
        sa.Column('booking_id', sa.String(), sa.ForeignKey('bookings.id'), nullable=True),
        sa.Column('current_rate', sa.Float(), nullable=False),
        sa.Column('floor_rate', sa.Float(), nullable=False, server_default='0.0'),
        sa.Column('channel', sa.Enum('OTA', 'DIRECT', 'GDS', 'WALKIN', 'CLOSED', name='channel'), nullable=False),
        sa.Column('min_stay_active', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('min_stay_nights', sa.Integer(), nullable=False, server_default='1'),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    op.drop_table('slots')
    op.drop_table('bookings')
    op.drop_table('rooms')
    op.execute("DROP TYPE IF EXISTS blocktype")
    op.execute("DROP TYPE IF EXISTS channel")
    op.execute("DROP TYPE IF EXISTS roomcategory")
