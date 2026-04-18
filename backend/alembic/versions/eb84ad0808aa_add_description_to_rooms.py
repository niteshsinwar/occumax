"""add_description_to_rooms

Revision ID: eb84ad0808aa
Revises: f1a134d3b52e
Create Date: 2026-04-18

Capability test: add nullable description column to rooms.
Demonstrates ADD COLUMN migration through CI/CD.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'eb84ad0808aa'
down_revision: Union[str, None] = 'f1a134d3b52e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('rooms', sa.Column('description', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('rooms', 'description')
