"""add_channel_partner_to_slot

Revision ID: b227ced3351d
Revises: eb84ad0808aa
Create Date: 2026-04-18 18:47:34.433594

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'b227ced3351d'
down_revision: Union[str, None] = 'eb84ad0808aa'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('slots', sa.Column('channel_partner', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('slots', 'channel_partner')
