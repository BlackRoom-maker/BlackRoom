# backend/db/models.py
from __future__ import annotations
from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, Text, DateTime, Boolean, ForeignKey, Index
)
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()

def utcnow() -> datetime:
    return datetime.utcnow()

class Device(Base):
    """
    Identifica o remetente sem contas:
    - device_fingerprint: ID persistente enviado pelo cliente (gerado e guardado no browser/app).
    - label: texto apresentável (ex.: "Alpha iPhone 13" ou "iMac do Eric").
    - user_agent/ip: última impressão capturada.
    """
    __tablename__ = "devices"

    id = Column(Integer, primary_key=True)
    device_fingerprint = Column(String(80), unique=True, nullable=True)  # opcional, mas recomendável
    label = Column(String(120), nullable=True)
    user_agent = Column(Text, nullable=True)

    ip_first = Column(String(64), nullable=True)
    ip_last = Column(String(64), nullable=True)

    first_seen = Column(DateTime, default=utcnow, nullable=False)
    last_seen = Column(DateTime, default=utcnow, nullable=False)

    active = Column(Boolean, default=True, nullable=False)

    messages = relationship("Message", back_populates="device", lazy="selectin")

    __table_args__ = (
        Index("ix_devices_last_seen", last_seen.desc()),
    )

class Room(Base):
    """
    Sala/conversa. Mantemos simples: nome único human-friendly.
    """
    __tablename__ = "rooms"

    id = Column(Integer, primary_key=True)
    name = Column(String(80), unique=True, nullable=False)
    created_at = Column(DateTime, default=utcnow, nullable=False)

    messages = relationship("Message", back_populates="room", lazy="selectin")

class Message(Base):
    """
    Mensagens persistentes.
    - content_type: 'text' | 'voice' | 'file' | 'system'
    - content: texto (quando for texto). Para ficheiros/áudio, guardar referência/hashes.
    - file_ref: chave/ficheiro local (hash, caminho ou id do cofre); futuramente ciphertext.
    - ip_at_send/ua_at_send: carimbo do remetente no momento do envio (sem contas).
    """
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True)
    room_id = Column(Integer, ForeignKey("rooms.id"), nullable=False)
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=True)

    content_type = Column(String(16), default="text", nullable=False)
    content = Column(Text, nullable=True)
    file_ref = Column(Text, nullable=True)

    ip_at_send = Column(String(64), nullable=True)
    ua_at_send = Column(Text, nullable=True)

    created_at = Column(DateTime, default=utcnow, nullable=False)

    room = relationship("Room", back_populates="messages")
    device = relationship("Device", back_populates="messages")

    __table_args__ = (
        Index("ix_messages_room_created", "room_id", "created_at"),
        Index("ix_messages_device_created", "device_id", "created_at"),
    )
