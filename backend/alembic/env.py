import os
from logging.config import fileConfig
from sqlalchemy import engine_from_config, pool
from alembic import context

# Load app config to get DATABASE_URL from .env
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Pull DATABASE_URL from env — convert asyncpg → psycopg2 for sync alembic runner
db_url = os.environ.get("DATABASE_URL", "")
db_url = db_url.replace("postgresql+asyncpg://", "postgresql://")
db_url = db_url.replace("asyncpg://", "postgresql://")
config.set_main_option("sqlalchemy.url", db_url)

# Import all models so autogenerate can detect them
from services.database import Base  # noqa: F401 — registers Base
import core.models.room     # noqa: F401
import core.models.slot     # noqa: F401
import core.models.booking  # noqa: F401

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
