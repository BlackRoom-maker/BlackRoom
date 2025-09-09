# backend/db/database.py
from __future__ import annotations
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Caminho absoluto do ficheiro SQLite dentro da pasta /db
BASE_DIR = Path(__file__).resolve().parents[2]  # .../blackroom
DB_DIR = BASE_DIR / "db"
DB_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DB_DIR / "blackroom.sqlite3"

DATABASE_URL = f"sqlite:///{DB_PATH}"

# echo=False para não “poluir” o terminal; mude para True se quiser logs SQL.
engine = create_engine(
    DATABASE_URL,
    echo=False,
    future=True,
    connect_args={"check_same_thread": False},  # útil para uso posterior com FastAPI
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
