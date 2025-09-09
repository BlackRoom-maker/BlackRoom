# backend/server.py
# Servidor local com FastAPI + WebSocket + SQLite
# - Identifica dispositivos por fingerprint/label (sem contas)
# - Captura IP e User-Agent
# - Persiste mensagens por sala
# - Broadcast em tempo real por sala
from __future__ import annotations

import json
from typing import Dict, Set
from datetime import datetime

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.db.database import SessionLocal
from backend.db.models import Device, Room, Message, Base

app = FastAPI(title="BlackRoom Local Server", version="0.1")

# CORS aberto para testes locais; em produção restrinja.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- DB session dependency ----------
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ---------- Modelos Pydantic ----------
class DeviceUpsert(BaseModel):
    fingerprint: str | None = Field(None, description="ID gerado no dispositivo (opcional, mas recomendado)")
    label: str | None = Field(None, description='Ex.: "Alpha iPhone 13", "iMac do Eric"')

class MessageIn(BaseModel):
    room: str = Field(..., description="Nome da sala (ex.: alpha)")
    content_type: str = Field("text", pattern="^(text|voice|file|system)$")
    content: str | None = None
    file_ref: str | None = None
    fingerprint: str | None = None
    label: str | None = None  # usado se ainda não houver device cadastrado no servidor

class MessageOut(BaseModel):
    id: int
    room: str
    device_label: str | None
    ip: str | None
    content_type: str
    content: str | None
    file_ref: str | None
    ts: datetime

# ---------- Utilidades ----------
def resolve_ip(request: Request) -> str:
    # Em redes locais geralmente client.host é suficiente
    # (Se estivesse atrás de proxy, poderíamos olhar X-Forwarded-For)
    return request.client.host if request.client else None

def upsert_device(db: Session, *, fingerprint: str | None, label: str | None, ip: str | None, user_agent: str | None) -> Device:
    dev = None
    if fingerprint:
        dev = db.scalar(select(Device).where(Device.device_fingerprint == fingerprint))
    if not dev and label:
        # fallback fraco por label (não único, apenas para primeiro registo sem fingerprint)
        dev = db.scalar(select(Device).where(Device.label == label))

    if not dev:
        dev = Device(
            device_fingerprint=fingerprint,
            label=label,                # cria já com o label informado
            user_agent=user_agent,
            ip_first=ip,
            ip_last=ip,
        )
        db.add(dev)
    else:
        # >>> PATCH: atualizar label se mudou <<<
        if label and label.strip() and label != dev.label:
            dev.label = label.strip()
        # ---------------------------------------
        dev.user_agent = user_agent or dev.user_agent
        dev.ip_last = ip or dev.ip_last
        dev.last_seen = datetime.utcnow()

    db.commit()
    db.refresh(dev)
    return dev

def ensure_room(db: Session, name: str) -> Room:
    room = db.scalar(select(Room).where(Room.name == name))
    if not room:
        room = Room(name=name)
        db.add(room)
        db.commit()
        db.refresh(room)
    return room

# ---------- REST: registar/atualizar dispositivo ----------
@app.post("/device/upsert")
def device_upsert(payload: DeviceUpsert, request: Request, db: Session = Depends(get_db)):
    ip = resolve_ip(request)
    ua = request.headers.get("user-agent")
    dev = upsert_device(db, fingerprint=payload.fingerprint, label=payload.label, ip=ip, user_agent=ua)
    return {"ok": True, "device_id": dev.id, "label": dev.label, "ip_last": dev.ip_last}

# ---------- REST: enviar mensagem (HTTP) ----------
@app.post("/messages")
def post_message(payload: MessageIn, request: Request, db: Session = Depends(get_db)):
    ip = resolve_ip(request)
    ua = request.headers.get("user-agent")

    room = ensure_room(db, payload.room)
    dev = upsert_device(db, fingerprint=payload.fingerprint, label=payload.label, ip=ip, user_agent=ua)

    msg = Message(
        room_id=room.id,
        device_id=dev.id,
        content_type=payload.content_type,
        content=payload.content,
        file_ref=payload.file_ref,
        ip_at_send=ip,
        ua_at_send=ua,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    # broadcast para assinantes WS daquela sala
    data = {
        "type": "msg",
        "room": room.name,
        "device": {"id": dev.id, "label": dev.label, "ip": ip},
        "content_type": msg.content_type,
        "content": msg.content,
        "file_ref": msg.file_ref,
        "ts": msg.created_at.isoformat(),
        "id": msg.id,
    }
    _broadcast_room(room.name, data)

    return {"ok": True, "id": msg.id}

# ---------- REST: histórico ----------
@app.get("/rooms/{room_name}/history", response_model=list[MessageOut])
def room_history(room_name: str, limit: int = 100, db: Session = Depends(get_db)):
    room = db.scalar(select(Room).where(Room.name == room_name))
    if not room:
        return []
    rows = db.execute(
        select(Message, Device)
        .join(Device, isouter=True)
        .where(Message.room_id == room.id)
        .order_by(Message.created_at.desc())
        .limit(limit)
    ).all()

    out: list[MessageOut] = []
    for msg, dev in rows[::-1]:  # retorna em ordem cronológica
        out.append(MessageOut(
            id=msg.id,
            room=room.name,
            device_label=(dev.label if dev else None),
            ip=msg.ip_at_send,
            content_type=msg.content_type,
            content=msg.content,
            file_ref=msg.file_ref,
            ts=msg.created_at,
        ))
    return out

# ---------- WebSocket: por sala ----------
# Mantém um mapa de sala -> conjunto de websockets
ROOM_CLIENTS: Dict[str, Set[WebSocket]] = {}

def _broadcast_room(room: str, payload: dict):
    dead: list[WebSocket] = []
    for ws in ROOM_CLIENTS.get(room, set()):
        try:
            ws.send_text(json.dumps(payload))
        except Exception:
            dead.append(ws)
    # remove clientes mortos
    for ws in dead:
        ROOM_CLIENTS.get(room, set()).discard(ws)

@app.websocket("/ws/{room}")
async def ws_room(ws: WebSocket, room: str):
    await ws.accept()
    ROOM_CLIENTS.setdefault(room, set()).add(ws)
    # sinal de presença (contagem)
    try:
        await ws.send_text(json.dumps({"type": "presence", "room": room, "count": len(ROOM_CLIENTS[room])}))
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            # Espera formato: {type:"msg", content:"...", content_type?, fingerprint?, label?}
            if data.get("type") == "msg":
                # Como é WS, não temos Request; IP via headers não vem nativo.
                # Em LAN, o IP pode não estar disponível aqui de forma portátil.
                # Guardamos "unknown" e deixamos o cliente usar REST /messages para persistir,
                # mas também aceitamos gravar daqui como fallback:
                with SessionLocal() as db:
                    dev = upsert_device(
                        db,
                        fingerprint=data.get("fingerprint"),
                        label=data.get("label"),
                        ip=None,  # não confiável via WS cru
                        user_agent=None,
                    )
                    room_row = ensure_room(db, room)
                    msg = Message(
                        room_id=room_row.id,
                        device_id=dev.id,
                        content_type=data.get("content_type") or "text",
                        content=data.get("content"),
                        file_ref=data.get("file_ref"),
                        ip_at_send=None,
                        ua_at_send=None,
                    )
                    db.add(msg)
                    db.commit()
                    db.refresh(msg)

                    payload = {
                        "type": "msg",
                        "room": room_row.name,
                        "device": {"id": dev.id, "label": dev.label, "ip": None},
                        "content_type": msg.content_type,
                        "content": msg.content,
                        "file_ref": msg.file_ref,
                        "ts": msg.created_at.isoformat(),
                        "id": msg.id,
                    }
                    _broadcast_room(room_row.name, payload)
    except WebSocketDisconnect:
        pass
    finally:
        ROOM_CLIENTS.get(room, set()).discard(ws)
        # envia nova presença
        try:
            await ws.send_text(json.dumps({"type": "presence", "room": room, "count": len(ROOM_CLIENTS.get(room, set()))}))
        except Exception:
            pass

# ---------- Inicialização de segurança: garante tabelas ----------
@app.on_event("startup")
def _startup():
    # Garantir que as tabelas existem (idempotente)
    Base.metadata.create_all(bind=SessionLocal.kw["bind"])





# === ÁUDIO LOCAL: upload e servir (com extensão/MIME corretos) ==============
from pathlib import Path
import hashlib
from fastapi import UploadFile, File, Form
from fastapi.responses import FileResponse
from fastapi import HTTPException

BASE_DIR = Path(__file__).resolve().parents[1]  # .../backend
DATA_DIR = BASE_DIR.parent / "data"
AUDIO_DIR = DATA_DIR / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

# Mapear content-type -> extensão preferida
CT_TO_EXT = {
    "audio/ogg; codecs=opus": "ogg",
    "audio/ogg": "ogg",
    "audio/webm; codecs=opus": "webm",
    "audio/webm": "webm",
    "audio/mp4; codecs=opus": "m4a",   # Safari costuma usar mp4/m4a
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
}
# Extensão -> content-type de resposta
EXT_TO_CT = {
    "ogg":  "audio/ogg",
    "webm": "audio/webm",
    "m4a":  "audio/mp4",
}

def _sha256_bytes(b: bytes) -> str:
    h = hashlib.sha256(); h.update(b); return h.hexdigest()

def _pick_ext(upload: UploadFile) -> str:
    ct = (upload.content_type or "").lower().strip()
    if ct in CT_TO_EXT:
        return CT_TO_EXT[ct]
    if ct.startswith("audio/"):
        if "webm" in ct: return "webm"
        if "ogg"  in ct: return "ogg"
        if "mp4"  in ct or "m4a" in ct: return "m4a"
    return "webm"

def _safe_key(name: str) -> str:
    name = name.strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail="object_key inválido")
    return name

@app.post("/upload/voice")
async def upload_voice(
    request: Request,
    file: UploadFile = File(...),
    room: str = Form("alpha"),
    fingerprint: str | None = Form(None),
    label: str | None = Form(None),
    db: Session = Depends(get_db),
):
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Ficheiro vazio")

    sha = _sha256_bytes(raw)
    ext = _pick_ext(file)
    object_key = f"{sha}.{ext}"
    dest = AUDIO_DIR / object_key
    if not dest.exists():
        dest.write_bytes(raw)

    ip = resolve_ip(request)
    ua = request.headers.get("user-agent")
    room_row = ensure_room(db, room)
    dev = upsert_device(db, fingerprint=fingerprint, label=label, ip=ip, user_agent=ua)

    msg = Message(
        room_id=room_row.id,
        device_id=dev.id,
        content_type="voice",
        content=None,
        file_ref=object_key,
        ip_at_send=ip,
        ua_at_send=ua,
    )
    db.add(msg); db.commit(); db.refresh(msg)

    payload = {
        "type": "msg",
        "room": room_row.name,
        "device": {"id": dev.id, "label": dev.label, "ip": ip},
        "content_type": "voice",
        "content": None,
        "file_ref": object_key,
        "ts": msg.created_at.isoformat(),
        "id": msg.id,
    }
    _broadcast_room(room_row.name, payload)

    return {"ok": True, "id": msg.id, "object_key": object_key}

@app.get("/files/audio/{object_key}")
def get_audio(object_key: str):
    key = _safe_key(object_key)
    path = AUDIO_DIR / key
    if not path.exists():
        raise HTTPException(status_code=404, detail="não encontrado")

    ext = path.suffix.lower().lstrip(".")
    media_type = EXT_TO_CT.get(ext, "audio/webm")
    return FileResponse(path, media_type=media_type, filename=path.name)



# === BLOB GENÉRICO: upload e servir (imagens, vídeos, docs) ================
from pathlib import Path
import hashlib, mimetypes
from fastapi import UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse

FILES_DIR = DATA_DIR / "files"
FILES_DIR.mkdir(parents=True, exist_ok=True)

def sha256_bytes(b: bytes) -> str:
    h = hashlib.sha256(); h.update(b); return h.hexdigest()

def pick_ext_from_upload(upload: UploadFile) -> str:
    ct = (upload.content_type or "").lower().strip()
    # tenta pelo mimetype
    ext = mimetypes.guess_extension(ct) or ""
    # normalizações comuns
    if ext in (".jpe",): ext = ".jpg"
    if ext in ("", None):
        # fallback pelo filename original
        ext = Path(upload.filename or "").suffix
    if not ext:
        ext = ".bin"
    return ext.lstrip(".")

def classify_content_type(ct: str) -> str:
    ct = (ct or "").lower()
    if ct.startswith("image/"): return "image"
    if ct.startswith("video/"): return "video"
    return "file"

@app.post("/upload/blob")
async def upload_blob(
    request: Request,
    file: UploadFile = File(...),
    room: str = Form("alpha"),
    fingerprint: str | None = Form(None),
    label: str | None = Form(None),
    db: Session = Depends(get_db),
):
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Ficheiro vazio")

    sha = sha256_bytes(raw)
    ext = pick_ext_from_upload(file)
    object_key = f"{sha}.{ext}"
    dest = FILES_DIR / object_key
    if not dest.exists():
        dest.write_bytes(raw)

    # classifica para a timeline
    content_category = classify_content_type(file.content_type)

    # persistir mensagem
    ip = resolve_ip(request)
    ua = request.headers.get("user-agent")
    room_row = ensure_room(db, room)
    dev = upsert_device(db, fingerprint=fingerprint, label=label, ip=ip, user_agent=ua)

    msg = Message(
        room_id=room_row.id,
        device_id=dev.id,
        content_type=content_category,   # "image" | "video" | "file"
        content=file.filename,           # guardamos o nome original no campo content
        file_ref=object_key,             # referência do ficheiro guardado
        ip_at_send=ip,
        ua_at_send=ua,
    )
    db.add(msg); db.commit(); db.refresh(msg)

    # broadcast
    payload = {
        "type": "msg",
        "room": room_row.name,
        "device": {"id": dev.id, "label": dev.label, "ip": ip},
        "content_type": content_category,
        "content": file.filename,
        "file_ref": object_key,
        "mime": file.content_type,
        "ts": msg.created_at.isoformat(),
        "id": msg.id,
    }
    _broadcast_room(room_row.name, payload)

    return {"ok": True, "id": msg.id, "object_key": object_key, "category": content_category}

@app.get("/files/blob/{object_key}")
def get_blob(object_key: str):
    key = object_key.strip()
    if not key or "/" in key or "\\" in key or ".." in key:
        raise HTTPException(status_code=400, detail="object_key inválido")
    path = FILES_DIR / key
    if not path.exists():
        raise HTTPException(status_code=404, detail="não encontrado")

    # content-type a partir da extensão
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type, filename=path.name)
