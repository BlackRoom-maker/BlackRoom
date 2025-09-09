# backend/db/init_db.py
from __future__ import annotations
from sqlalchemy import select
from .database import engine, SessionLocal
from .models import Base, Room

def main():
    # 1) Criar tabelas (se não existirem)
    Base.metadata.create_all(bind=engine)

    # 2) Semear sala padrão "alpha" (se não existir)
    with SessionLocal() as session:
        exists = session.scalar(select(Room).where(Room.name == "alpha"))
        if not exists:
            session.add(Room(name="alpha"))
            session.commit()
            print("✅ Sala 'alpha' criada.")
        else:
            print("ℹ️ Sala 'alpha' já existe.")

    print("✅ DB pronto.")

if __name__ == "__main__":
    main()
