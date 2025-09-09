/* ==========================================================================
   BLACKROOM — assets/js/app.js (com VOZ, histórico e WS handler robusto)
   ========================================================================== */

/* ---------- Config global de endpoints (frontend porta 9000 / backend 8001) */
window.HOST    = location.hostname || "localhost";
window.API_URL = `http://${window.HOST}:8001`;
window.WS_URL  = `ws://${window.HOST}:8001/ws`;
console.log("Configuração carregada:", window.API_URL, window.WS_URL);

/* ---------- Log shim (sempre disponível) ---------------------------------- */
if (typeof window.log !== "function") {
  window.log = function (line) {
    try {
      const el = document.getElementById("log-stream");
      if (el) {
        const p = document.createElement("p");
        p.textContent = `# ${line}`;
        el.appendChild(p);
        el.scrollTop = el.scrollHeight;
        return;
      }
    } catch (_) {}
    console.log(line);
  };
}

/* ---------- Helpers de DOM/UI -------------------------------------------- */
const $ = (id) => document.getElementById(id);
const messageList = $("message-list");
const logStream   = $("log-stream");
const wsStatus    = $("ws-status");
const peerCount   = $("peer-count");
const roomTitleEl = $("room-title");

/* ---------- Identidade local (SweetAlert2) -------------------------------- */
let fingerprint = localStorage.getItem("br_fingerprint");
if (!fingerprint) {
  fingerprint = self.crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  localStorage.setItem("br_fingerprint", fingerprint);
}

let label = localStorage.getItem("br_label");

async function askLabel(initial = "") {
  if (!window.Swal) {
    const v = prompt("Label / Nome do dispositivo:", initial || "");
    return (v || "").trim();
  }
  const { value: newLabel } = await Swal.fire({
    title: "Identifique-se",
    text: "Escolha um nome que o outro utilizador poderá ver.",
    input: "text",
    inputLabel: "Label / Nome do dispositivo",
    inputPlaceholder: "Ex.: Alpha iPhone 13",
    inputValue: initial,
    confirmButtonText: "Salvar",
    allowOutsideClick: false,
    allowEscapeKey: false,
    inputValidator: (v) => {
      if (!v || v.trim().length < 3) return "Mínimo de 3 caracteres.";
    }
  });
  return (newLabel || "").trim();
}

(async () => {
  if (!label) {
    label = await askLabel();
    localStorage.setItem("br_label", label);
  }
  $("device-label").textContent = label;
})();

function currentLabel() { return (window.label || localStorage.getItem("br_label") || "Você"); }

/* ---------- REST/DB ------------------------------------------------------- */
async function registerDevice() {
  try {
    const res = await fetch(`${window.API_URL}/device/upsert`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ fingerprint, label: currentLabel() })
    });
    const data = await res.json();
    $("device-ip").textContent = data.ip_last || "—";
    $("device-ua").textContent = navigator.userAgent;
    log(`Dispositivo registado como ${currentLabel()} (${fingerprint.slice(0,6)})`);
  } catch (_) {
    log("Erro ao registar dispositivo");
  }
}

/* ---------- Mensagens: render texto -------------------------------------- */
function addMessage(msg, dir = "in") {
  const art = document.createElement("article");
  art.className = `msg ${dir}`;
  const head = document.createElement("header");
  head.className = "msg-head";
  const who = document.createElement("span");
  who.className = "author";
  who.textContent = msg.device_label || "—";
  const time = document.createElement("time");
  time.className = "time";
  const ts = msg.ts ? new Date(msg.ts) : new Date();
  time.textContent = ts.toLocaleTimeString("pt-PT",{hour:"2-digit",minute:"2-digit"});
  head.append(who, time);

  const bubble = document.createElement("p");
  bubble.className = "bubble";
  bubble.textContent = msg.content || "";
  art.append(head, bubble);
  messageList.appendChild(art);
  messageList.scrollTop = messageList.scrollHeight;
}

/* ---------- Mensagens: render VOZ ---------------------------------------- */
function renderVoiceMessage({ file_ref, device_label, ts }, dir = "in") {
  const art = document.createElement("article");
  art.className = `msg ${dir}`;
  const head = document.createElement("header"); head.className = "msg-head";
  const who  = document.createElement("span"); who.className = "author"; who.textContent = device_label || "—";
  const time = document.createElement("time"); time.className = "time";
  time.textContent = new Date(ts).toLocaleTimeString("pt-PT",{hour:"2-digit",minute:"2-digit"});
  head.append(who, time);

  const bubble = document.createElement("div"); bubble.className = "bubble";
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.src = `${window.API_URL}/files/audio/${file_ref}`;
  audio.style.width = "100%";
  bubble.appendChild(audio);

  art.append(head, bubble);
  messageList.appendChild(art);
  messageList.scrollTop = messageList.scrollHeight;
}

/* ---------- Histórico (texto + voz) -------------------------------------- */
async function loadHistory(room = "alpha") {
  try {
    const res = await fetch(`${window.API_URL}/rooms/${room}/history?limit=200`);
    const data = await res.json();
    messageList.innerHTML = "";
    const me = currentLabel();
    data.forEach(m => {
      const dir = (m.device_label === me) ? "out" : "in";
      if (m.content_type === "voice" && m.file_ref) {
        renderVoiceMessage(m, dir);
      } else if (m.content_type === "image" && m.file_ref) {
        renderImageMessage(m, dir);
      } else if (m.content_type === "video" && m.file_ref) {
        renderVideoMessage(m, dir);
      } else if (m.content_type === "file" && m.file_ref) {
        renderFileMessage({ ...m, name: m.content }, dir);
      } else {
        addMessage(m, dir);
      }
    });
    log(`Histórico da sala ${room} carregado (${data.length} msgs)`);
  } catch (_) {
    log("Erro ao carregar histórico");
  }
}

/* ---------- WebSocket ----------------------------------------------------- */
window.ws = null;
function connectWS(room = "alpha") {
  window.ws = new WebSocket(`${window.WS_URL}/${room}`);

  window.ws.onopen = () => {
    wsStatus.textContent = "ONLINE";
    wsStatus.style.color = "var(--ok)";
    log(`Conectado a sala #${room}`);
  };

  window.ws.onclose = () => {
    wsStatus.textContent = "OFFLINE";
    wsStatus.style.color = "var(--danger)";
    log("WebSocket fechado, reconectando...");
    setTimeout(() => connectWS(room), 1500);
  };

  installWsHandler(); // instala o handler da mensagem
}

// ---- WebSocket: handler único e robusto -----------------------------------
function installWsHandler() {
  if (!window.ws) return;

  window.ws.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }

    // 1) Presença (contador de peers)
    if (data.type === "presence") {
      const n = (typeof data.count === "number") ? data.count : null;
      if (n !== null) peerCount.textContent = String(n).padStart(2, "0");
      return;
    }

    // 2) Mensagens (texto/voz/imagem/vídeo/ficheiro)
    if (data.type === "msg") {
      const mine = (data.device?.label === currentLabel());
      const dir  = mine ? "out" : "in";

      // voz (nota de áudio)
      if (data.content_type === "voice" && data.file_ref) {
        return renderVoiceMessage(
          { file_ref: data.file_ref, device_label: data.device?.label || "—", ts: data.ts },
          dir
        );
      }

      // imagem
      if (data.content_type === "image" && data.file_ref) {
        return renderImageMessage(
          { file_ref: data.file_ref, device_label: data.device?.label || "—", ts: data.ts },
          dir
        );
      }

      // vídeo
      if (data.content_type === "video" && data.file_ref) {
        return renderVideoMessage(
          { file_ref: data.file_ref, device_label: data.device?.label || "—", ts: data.ts },
          dir
        );
      }

      // ficheiro genérico (pdf/zip/doc etc.)
      if (data.content_type === "file" && data.file_ref) {
        return renderFileMessage(
          { file_ref: data.file_ref, device_label: data.device?.label || "—", ts: data.ts, name: data.content },
          dir
        );
      }

      // texto “normal” (fallback)
      return addMessage({
        content: data.content,
        device_label: data.device?.label || "—",
        ts: data.ts
      }, dir);
    }
  };
}

// revalida periodicamente (cobre reconexões)
setInterval(() => { installWsHandler(); }, 2000);

/* ---------- Composer (enviar texto) -------------------------------------- */
$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("input-msg").value.trim();
  if (!text) return;

  try {
    const payload = {
      room: roomTitleEl.textContent,
      content_type: "text",
      content: text,
      fingerprint,
      label: currentLabel()
    };
    const res = await fetch(`${window.API_URL}/messages`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.ok) $("input-msg").value = "";
  } catch (_) {
    log("Erro ao enviar mensagem");
  }
});

/* ---------- Botões do painel Dispositivo --------------------------------- */
$("device-edit").addEventListener("click", async () => {
  const current = currentLabel();
  const newLabel = await askLabel(current);
  if (newLabel && newLabel !== current) {
    label = newLabel;
    localStorage.setItem("br_label", label);
    $("device-label").textContent = label;
    registerDevice();
    log(`Label atualizado para: ${label}`);
  }
});
$("device-register").addEventListener("click", () => registerDevice());

/* ---------- Telemetria (efeito visual) ----------------------------------- */
(function startTelemetry() {
  const elPing   = $("tele-ping");
  const elUptime = $("tele-uptime");
  const elSync   = $("tele-sync");
  const spark    = $("sparkline");
  const t0 = performance.now();
  const fmtUp = (ms)=> (ms/3600000).toFixed(2);

  function tick() {
    const ping = Math.round(28 + Math.random()*57);
    const sync = (500 + Math.random()*480).toFixed(0);
    const up   = fmtUp(performance.now() - t0);
    if (elPing)   elPing.textContent = `${ping} ms`;
    if (elSync)   elSync.textContent = `${sync} k/s`;
    if (elUptime) elUptime.textContent = up;
  }
  tick(); setInterval(tick, 1800);

  if (spark && spark.getContext) {
    const ctx = spark.getContext("2d");
    function resize(){
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      spark.width = Math.floor(spark.clientWidth * dpr);
      spark.height= Math.floor(spark.clientHeight* dpr);
      ctx.setTransform(dpr,0,0,dpr,0,0);
    }
    resize(); addEventListener("resize", resize);
    const N=96, data=Array.from({length:N},()=>0.5+(Math.random()-0.5)*0.2);
    function step(){
      data.shift();
      let next = (data[data.length-1]||0.5) + (Math.random()-0.5)*0.08;
      next = Math.max(0.12, Math.min(0.95, next)); data.push(next);
      const w=spark.clientWidth,h=spark.clientHeight;
      ctx.clearRect(0,0,w,h); ctx.lineWidth=1.5; ctx.strokeStyle="rgba(0,255,168,0.85)";
      ctx.beginPath();
      data.forEach((v,i)=>{ const x=(i/(N-1))*(w-8)+4; const y=h-(v*(h-8))-4; i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
      ctx.stroke();
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
})();

/* ---------- ÁUDIO (gravação + prévia + envio) ---------------------------- */
(function setupAudio() {
  const micBtn   = $("btn-mic");
  const roomName = () => $("room-title").textContent;

  const MIME_CANDIDATES = [
    "audio/ogg; codecs=opus",
    "audio/webm; codecs=opus",
    "audio/webm",
    "audio/mp4; codecs=opus",
    "audio/mp4"
  ];
  const MIME = (window.MediaRecorder && MediaRecorder.isTypeSupported)
    ? (MIME_CANDIDATES.find(t => MediaRecorder.isTypeSupported(t)) || "")
    : "";
  let fileExt = MIME.includes("ogg") ? "ogg" : (MIME.includes("webm") ? "webm" : "m4a");

  let mediaRecorder = null, chunks = [], t0 = 0, timerId = null;
  let draftEl = null, draftBlob = null, draftUrl = null;

  function fmt(ms){ const s=Math.floor(ms/1000); return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`; }

  // Indicador de gravação
  function showIndicator(){
    if ($("rec-indicator")) return;
    const chip = document.createElement("div");
    chip.id = "rec-indicator";
    chip.style.cssText = `
      position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%);
      z-index: 1000; display: inline-flex; align-items: center; gap: 10px;
      padding: 8px 12px; border-radius: 999px;
      border: 1px solid rgba(255,0,0,.55);
      background: rgba(255,0,0,.12); color: #ff4d6d;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      box-shadow: 0 8px 28px rgba(0,0,0,.35);
    `;
    chip.innerHTML = `● Gravando <span id="rec-timer">00:00</span> — clique no 🎤 para parar`;
    document.body.appendChild(chip);
  }
  function hideIndicator(){ const el=$("rec-indicator"); if(el) el.remove(); if(timerId){ clearInterval(timerId); timerId=null; } }

  // Pré-visualização
  function showDraft(blob, durationMs) {
    if (draftEl) { try { draftEl.remove(); } catch(_){} draftEl = null; }
    draftBlob = blob; draftUrl = URL.createObjectURL(blob);

    const art = document.createElement("article"); art.className = "msg out";
    const head= document.createElement("header"); head.className="msg-head";
    const who = document.createElement("span"); who.className="author"; who.textContent = currentLabel();
    const time= document.createElement("time"); time.className="time"; time.textContent = new Date().toLocaleTimeString("pt-PT",{hour:"2-digit",minute:"2-digit"});
    head.append(who,time);

    const bubble = document.createElement("div"); bubble.className="bubble";
    const audio  = document.createElement("audio"); audio.controls=true; audio.src=draftUrl; audio.style.width="100%";
    const controls = document.createElement("div"); controls.style.display="flex"; controls.style.gap="8px"; controls.style.marginTop="8px";
    const sendBtn = document.createElement("button"); sendBtn.className="btn small"; sendBtn.textContent="Enviar";
    const dropBtn = document.createElement("button"); dropBtn.className="btn small danger"; dropBtn.textContent="Descartar";
    const dur = document.createElement("span"); dur.style.marginLeft="auto"; dur.style.fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"; dur.style.color="var(--fg-1)"; dur.textContent=`⏱ ${fmt(durationMs)}`;
    controls.append(sendBtn, dropBtn, dur);
    bubble.append(audio, controls);
    art.append(head, bubble);
    messageList.appendChild(art); messageList.scrollTop = messageList.scrollHeight;
    draftEl = art;

    dropBtn.onclick = () => {
      if (draftEl) draftEl.remove(); draftEl=null;
      if (draftUrl) URL.revokeObjectURL(draftUrl); draftUrl=null; draftBlob=null;
      log("Gravação descartada.");
    };

    sendBtn.onclick = async () => {
      if (!draftBlob) { log("⚠️ Sem áudio para enviar."); return; }
      const originalText = sendBtn.textContent;
      sendBtn.textContent = "Enviando…";
      sendBtn.disabled = true; dropBtn.disabled = true;

      try {
        const fd = new FormData();
        fd.append("file", draftBlob, `voice.${fileExt}`);
        fd.append("room", roomName());
        fd.append("fingerprint", fingerprint);
        fd.append("label", currentLabel());

        const res  = await fetch(`${window.API_URL}/upload/voice`, { method: "POST", body: fd });
        const text = await res.text();
        let data={}; try { data = JSON.parse(text); } catch(_) {}
        if (res.ok && data.ok) {
          log(`✅ Áudio enviado. id=${data.id || "?"}`);
          sendBtn.textContent = "Enviado";
          sendBtn.disabled = true; dropBtn.disabled = true;
        } else {
          log(`❌ Falha ao enviar áudio: HTTP ${res.status} — ${text || "(sem corpo)"}`);
          if (window.Swal) await Swal.fire({icon:"error",title:"Erro ao enviar",text:`HTTP ${res.status}`,confirmButtonText:"OK"});
          sendBtn.textContent = originalText; sendBtn.disabled = false; dropBtn.disabled = false;
        }
      } catch (e) {
        console.error(e);
        log(`❌ Erro de rede ao enviar áudio: ${e.message || e}`);
        if (window.Swal) await Swal.fire({icon:"error",title:"Erro de rede",text:String(e),confirmButtonText:"OK"});
        sendBtn.textContent = originalText; sendBtn.disabled = false; dropBtn.disabled = false;
      }
    };
  }

  // Recorder
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream, MIME ? { mimeType: MIME } : undefined);
      chunks = []; t0 = performance.now();

      mediaRecorder.ondataavailable = (e) => { if (e && e.data && e.data.size>0) chunks.push(e.data); };
      mediaRecorder.onstop = () => {
        try { mediaRecorder.requestData && mediaRecorder.requestData(); } catch(_) {}
        setTimeout(() => {
          hideIndicator(); micBtn.classList.remove("recording");
          if (!chunks.length) { log("⚠️ Nenhum áudio capturado."); return; }
          const blob = new Blob(chunks, { type: MIME || "audio/webm" });
          if (blob.size === 0) { log("⚠️ Gravação vazia."); return; }
          showDraft(blob, performance.now()-t0);
        }, 80);
      };

      mediaRecorder.start(250); // timeslice
      showIndicator(); micBtn.classList.add("recording");
      log("🎤 Gravando… clique no 🎤 para parar.");
      const tick = () => { const t=$("rec-timer"); if (t) t.textContent = fmt(performance.now()-t0); };
      tick(); timerId = setInterval(tick, 250);
    } catch (_) {
      log("⚠️ Acesso ao microfone negado ou indisponível.");
    }
  }
  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try { mediaRecorder.requestData && mediaRecorder.requestData(); mediaRecorder.stop(); } catch(_) {}
    }
  }
  if (micBtn) micBtn.addEventListener("click", () => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") startRecording(); else stopRecording();
  });
})();

/* ---------- Bootstrap ----------------------------------------------------- */
registerDevice();
loadHistory("alpha");
connectWS("alpha");




// --- renderizadores para anexos ---
function renderImageMessage({ file_ref, device_label, ts }, dir="in") {
  const art = document.createElement("article");
  art.className = `msg ${dir}`;
  const head = document.createElement("header"); head.className="msg-head";
  const who  = document.createElement("span"); who.className="author"; who.textContent = device_label || "—";
  const time = document.createElement("time"); time.className="time"; time.textContent = new Date(ts).toLocaleTimeString("pt-PT",{hour:"2-digit",minute:"2-digit"});
  head.append(who,time);
  const bubble = document.createElement("div"); bubble.className="bubble";
  const img = document.createElement("img");
  img.src = `${window.API_URL}/files/blob/${file_ref}`;
  img.alt = "imagem";
  img.style.maxWidth = "420px"; img.style.borderRadius = "10px";
  bubble.appendChild(img);
  art.append(head,bubble); messageList.appendChild(art);
  messageList.scrollTop = messageList.scrollHeight;
}

function renderVideoMessage({ file_ref, device_label, ts }, dir="in") {
  const art = document.createElement("article");
  art.className = `msg ${dir}`;
  const head = document.createElement("header"); head.className="msg-head";
  const who  = document.createElement("span"); who.className="author"; who.textContent = device_label || "—";
  const time = document.createElement("time"); time.className="time"; time.textContent = new Date(ts).toLocaleTimeString("pt-PT",{hour:"2-digit",minute:"2-digit"});
  head.append(who,time);
  const bubble = document.createElement("div"); bubble.className="bubble";
  const video = document.createElement("video");
  video.controls = true; video.src = `${window.API_URL}/files/blob/${file_ref}`;
  video.style.width = "420px"; video.style.maxWidth = "100%"; video.style.borderRadius = "10px";
  bubble.appendChild(video);
  art.append(head,bubble); messageList.appendChild(art);
  messageList.scrollTop = messageList.scrollHeight;
}

function renderFileMessage({ file_ref, device_label, ts, name }, dir="in") {
  const art = document.createElement("article");
  art.className = `msg ${dir}`;
  const head = document.createElement("header"); head.className="msg-head";
  const who  = document.createElement("span"); who.className="author"; who.textContent = device_label || "—";
  const time = document.createElement("time"); time.className="time"; time.textContent = new Date(ts).toLocaleTimeString("pt-PT",{hour:"2-digit",minute:"2-digit"});
  head.append(who,time);
  const bubble = document.createElement("div"); bubble.className="bubble";
  const a = document.createElement("a");
  a.href = `${window.API_URL}/files/blob/${file_ref}`;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = name || "Transferir ficheiro";
  bubble.appendChild(a);
  art.append(head,bubble); messageList.appendChild(art);
  messageList.scrollTop = messageList.scrollHeight;
}



// === Anexos (📎) ============================================================
(function setupAttach() {
  const attachBtn  = $("btn-attach");
  const attachInput= $("attach-input");
  const roomName   = () => $("room-title").textContent;

  if (!attachBtn || !attachInput) return;

  attachBtn.addEventListener("click", () => {
    attachInput.value = ""; // reset para permitir re-selecionar o mesmo ficheiro
    attachInput.click();
  });

  attachInput.addEventListener("change", async () => {
    const files = Array.from(attachInput.files || []);
    if (!files.length) return;

    for (const file of files) {
      // UI: cartão de “enviando…”
      const placeholder = document.createElement("article");
      placeholder.className = "msg out";
      placeholder.innerHTML = `
        <header class="msg-head">
          <span class="author">${currentLabel()}</span>
          <time class="time">${new Date().toLocaleTimeString("pt-PT",{hour:"2-digit",minute:"2-digit"})}</time>
        </header>
        <div class="bubble"><em>Enviando ${file.name}…</em></div>
      `;
      messageList.appendChild(placeholder);
      messageList.scrollTop = messageList.scrollHeight;

      const fd = new FormData();
      fd.append("file", file, file.name);
      fd.append("room", roomName());
      fd.append("fingerprint", fingerprint);
      fd.append("label", currentLabel());

      try {
        const res  = await fetch(`${window.API_URL}/upload/blob`, { method: "POST", body: fd });
        const text = await res.text();
        let data={}; try { data = JSON.parse(text); } catch(_) {}

        if (res.ok && data.ok) {
          placeholder.querySelector(".bubble").innerHTML = `<em>${file.name} enviado.</em>`;
          // A bolha definitiva chega via WS (image/video/file)
        } else {
          placeholder.querySelector(".bubble").innerHTML = `<em>Erro ao enviar: HTTP ${res.status}</em>`;
          log(`❌ Falha ao enviar anexo: ${file.name} — ${text || "(sem corpo)"}`);
        }
      } catch (e) {
        placeholder.querySelector(".bubble").innerHTML = `<em>Erro de rede ao enviar.</em>`;
        log(`❌ Erro de rede ao enviar anexo: ${e.message || e}`);
      }
    }
  });
})();
