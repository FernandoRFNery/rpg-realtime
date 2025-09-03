
// server.js  (ESM + SQLite)
// Executar com: npm start
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import Database from "better-sqlite3";
import registerImageRoutes from "./images.js";
import * as fsp from "node:fs/promises";   // fs/promises para operações assíncronas
import crypto from 'crypto';

// --- paths/helpers (ESM __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

// diretórios base (com defaults que batem com os volumes do docker-compose)
const DATA_DIR     = process.env.DATA_DIR     || path.join(__dirname, "data");
const UPLOADS_DIR  = process.env.UPLOADS_DIR  || path.join(__dirname, "uploads");
const BACKUP_DIR   = process.env.BACKUP_DIR   || path.join(DATA_DIR, "backups");

// frontend
const PUBLIC_DIR      = process.env.PUBLIC_DIR || path.join(__dirname, "public");
const JSON_BOOTSTRAP  = path.join(__dirname, "campaign.json");

// banco
const DB_FILE = process.env.DB_PATH || path.join(DATA_DIR, "campaign.db");

// galeria (iguais aos usados no images.js)
const GALLERY_ROOT = path.join(UPLOADS_DIR, "images");
const THUMBS_ROOT  = path.join(GALLERY_ROOT, "_thumbs");

// garante que as pastas existem (sincrono e simples)
for (const dir of [DATA_DIR, UPLOADS_DIR, GALLERY_ROOT, THUMBS_ROOT, BACKUP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// --- Express + HTTP + Socket.IO
const app = express();
app.use(cors());
// Segurança básica de headers (CSP desativado para permitir inline do seu index.html)
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

app.use(express.json({ limit: "5mb" }));
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, p) => {
    if (p.endsWith('.html') || p.endsWith('.js') || p.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

const httpServer = createServer(app);

// Imagens (álbuns + legendas + ordem)
registerImageRoutes(app);

const io = new SocketIOServer(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- SQLite (campanha + snapshots)
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL"); // maior segurança em troca de performance
db.pragma("wal_autocheckpoint = 1000");

db.prepare(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS campaign (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`).run();

// --- Tabelas do Jukebox (estado + snapshots)
db.prepare(`
  CREATE TABLE IF NOT EXISTS jukebox (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS jukebox_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`).run();

// --- Helpers de segurança ---
function sha1(str){ return crypto.createHash('sha1').update(str).digest('hex'); }
function ts(){ return new Date().toISOString().replace(/[:.]/g,'-'); }
async function ensureDir(dir){ await fsp.mkdir(dir, { recursive: true }); }
async function writeBackupFile(prefix, jsonString){
  try{
    await ensureDir(BACKUP_DIR);
    const file = path.join(BACKUP_DIR, `${prefix}-${ts()}.json`);
    await fsp.writeFile(file, jsonString, 'utf8');
    const files = (await fsp.readdir(BACKUP_DIR)).filter(f=>f.startsWith(prefix + '-')).sort().reverse();
    await Promise.all(files.slice(MAX_BACKUPS).map(f=>fsp.rm(path.join(BACKUP_DIR, f)).catch(()=>{})));
  }catch(e){ console.warn(`[backup:${prefix}] falhou:`, e?.message||e); }
}

// --- Estado principal da Campanha
function stateLooksEmpty(obj){
  if (!obj || typeof obj !== 'object') return true;
  try{
    const tables = obj.tables; // principal fonte de dados
    if (Array.isArray(tables) && tables.length){
      const someRows = tables.some(t => Array.isArray(t.rows) && t.rows.length > 0);
      if (someRows) return false;
    }
    if ((obj.notes && String(obj.notes).trim()) || (obj.quickNotes && String(obj.quickNotes).trim())) return false;
    if (obj.lists && Array.isArray(obj.lists) && obj.lists.some(l => Array.isArray(l.items) && l.items.length)) return false;
  }catch{}
  return true;
}

function loadStateFromDB() {
  const row = db.prepare("SELECT data FROM campaign WHERE id=1").get();
  return row ? JSON.parse(row.data) : null;
}

function saveStateToDB(stateObj) {
  const data = JSON.stringify(stateObj ?? {}, null, 0);
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO snapshots (data) VALUES (?)`).run(data);
    db.prepare(`
      INSERT INTO campaign (id, data, updated_at)
      VALUES (1, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        data=excluded.data,
        updated_at=datetime('now')
    `).run(data);
  });
  tx();
  writeBackupFile('campaign', data).catch(()=>{});
}

// --- Bootstrap Campanha
let state = loadStateFromDB();
if (!state) {
  if (fs.existsSync(JSON_BOOTSTRAP)) {
    try {
      state = JSON.parse(fs.readFileSync(JSON_BOOTSTRAP, "utf8"));
      console.log(">> Bootstrap do campaign.json");
    } catch (e) {
      console.warn("campaign.json inválido; iniciando estado vazio.");
      state = {};
    }
  } else {
    state = {};
  }
  saveStateToDB(state);
}
let currentETag = sha1(JSON.stringify(state || {}));

// --- API REST (Campanha)
app.get("/api/campaign", (req, res) => {
  const etag = currentETag;
  if (req.headers['if-none-match'] && req.headers['if-none-match'] === etag){
    return res.status(304).end();
  }
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, data: state, etag });
});

app.put("/api/campaign", async (req, res) => {
  try{
    const payload = req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "Body precisa ser um objeto JSON" });
    }
    const jsonStr = JSON.stringify(payload);
    if (jsonStr.length > 2_500_000){ // ~2.5MB
      return res.status(413).json({ ok: false, error: "Payload muito grande" });
    }

    const ifMatch = req.headers['if-match'];
    if (ifMatch && ifMatch !== currentETag){
      return res.status(412).json({ ok:false, error:"ETag não confere (dados mudaram no servidor)" });
    }

    const allowEmpty = req.query.allowEmpty === '1' || req.headers['x-allow-empty'] === '1';
    if (!allowEmpty && stateLooksEmpty(payload)){
      return res.status(422).json({ ok:false, error:"Estado vazio bloqueado para evitar perda acidental. Envie ?allowEmpty=1 para forçar." });
    }

    saveStateToDB(payload);
    state = payload;
    currentETag = sha1(jsonStr);

    io.emit("state:broadcast", state);
    res.setHeader('ETag', currentETag);
    return res.json({ ok: true, etag: currentETag });
  }catch(err){
    console.error("[PUT /api/campaign] erro:", err);
    return res.status(500).json({ ok:false, error: err?.message || String(err) });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// --- Socket.IO realtime (Campanha genérica)
io.on("connection", (socket) => {
  console.log("socket conectado:", socket.id);
  socket.emit("state:broadcast", state);
  socket.on("state:update", (newState) => {
    if (!newState || typeof newState !== "object") return;
    state = newState;
    saveStateToDB(state);
    socket.broadcast.emit("state:broadcast", state);
  });
  socket.on("disconnect", () => {
    console.log("socket desconectado:", socket.id);
  });
});

// --- API extra: excluir álbum (imagens + thumbs). Protege o "default".
app.delete("/api/albums/:album", async (req, res) => {
  try {
    const normaliza = (s = "") =>
      String(s).trim().toLowerCase().replace(/[^a-z0-9-_]/gi, "");

    const album = normaliza(req.params.album);
    if (!album) {
      return res.status(400).json({ ok: false, error: "Nome de álbum inválido" });
    }
    if (album === "default") {
      return res.status(400).json({ ok: false, error: "O álbum padrão não pode ser excluído." });
    }

    const dirAlbum  = path.join(GALLERY_ROOT, album);
    const dirThumbs = path.join(THUMBS_ROOT, album);

    await fsp.rm(dirAlbum,  { recursive: true, force: true });
    await fsp.rm(dirThumbs, { recursive: true, force: true });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/albums/:album]", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Snapshots: listar e restaurar (campanha)
app.get("/api/campaign/snapshots", (_req, res) => {
  try{
    const rows = db.prepare("SELECT id, created_at, length(data) AS bytes FROM snapshots ORDER BY id DESC LIMIT 100").all();
    res.json({ ok:true, items: rows });
  }catch(err){ res.status(500).json({ ok:false, error: err.message }); }
});

app.post("/api/campaign/restore/:id", (req, res) => {
  try{
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok:false, error:"id inválido"});
    const row = db.prepare("SELECT data FROM snapshots WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ ok:false, error:"snapshot não encontrado"});
    const payload = JSON.parse(row.data);
    saveStateToDB(payload);
    state = payload;
    currentETag = sha1(row.data);
    io.emit("state:broadcast", state);
    res.setHeader('ETag', currentETag);
    res.json({ ok:true, restored: id });
  }catch(err){ res.status(500).json({ ok:false, error: err.message }); }
});

// --- Página: Regras da Casa
app.get("/regras", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "regras-da-casa.html"));
});

// ====== Jukebox: namespace Socket.IO + persistência no mesmo DB/backups ======

// Estado padrão
const defaultJBState = () => ({
  playlist: [],           // [{ url, videoId, badge, title? }]
  currentIndex: -1,       // índice da música atual
  isPlaying: false,       // está tocando?
  volume: 70,             // 0..100
  currentTime: 0          // segundos
});

function jbLoad(){
  const row = db.prepare("SELECT data FROM jukebox WHERE id=1").get();
  if (!row) return defaultJBState();
  try { return Object.assign(defaultJBState(), JSON.parse(row.data)); }
  catch { return defaultJBState(); }
}

function jbSave(state){
  const data = JSON.stringify(state ?? defaultJBState());
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO jukebox_snapshots (data) VALUES (?)`).run(data);
    db.prepare(`
      INSERT INTO jukebox (id, data, updated_at)
      VALUES (1, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        data=excluded.data,
        updated_at=datetime('now')
    `).run(data);
  });
  tx();
  writeBackupFile('jukebox', data).catch(()=>{});
}

let jbState = jbLoad();

// helpers
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function moveItem(arr, from, to){
  const a = arr.slice();
  const [it] = a.splice(from, 1);
  a.splice(to, 0, it);
  return a;
}

// Socket.IO namespace do jukebox
const jbio = io.of("/jukebox");

function broadcastState(){ jbio.emit("state", jbState); }
function toastAll(msg){ jbio.emit("toast", msg); }

jbio.on("connection", (socket) => {
  // Envia snapshot do estado para quem conectou
  socket.emit("state", jbState);

  socket.on("sync_request", () => {
    socket.emit("state", jbState);
  });

  socket.on("add_track", (item) => {
    try{
      if (!item || typeof item !== 'object') return;
      const { url, videoId, badge, title } = item;
      if (!videoId) return;
      jbState.playlist.push({ url: url || "", videoId, badge: badge || null, title: title || "" });
      jbSave(jbState);
      broadcastState();
    }catch{}
  });

  socket.on("play_index", ({ index, seek=0 } = {}) => {
    if (!Array.isArray(jbState.playlist) || !jbState.playlist.length) return;
    index = clamp(Number(index ?? 0), 0, jbState.playlist.length-1);
    jbState.currentIndex = index;
    jbState.isPlaying = true;
    jbState.currentTime = Math.max(0, Number(seek||0));
    jbSave(jbState);
    // evento direcionado para sincronizar players rapidamente
    jbio.emit("play_index", { index, seek: jbState.currentTime });
    // e o snapshot completo para manter UI
    broadcastState();
  });

  socket.on("skip_next", () => {
    if (!jbState.playlist.length) return;
    let i = jbState.currentIndex;
    i = (i < 0) ? 0 : i + 1;
    if (i >= jbState.playlist.length) i = 0; // loop
    jbState.currentIndex = i;
    jbState.isPlaying = true;
    jbState.currentTime = 0;
    jbSave(jbState);
    jbio.emit("play_index", { index: i, seek: 0 });
    broadcastState();
  });

  socket.on("skip_prev", () => {
    if (!jbState.playlist.length) return;
    let i = jbState.currentIndex;
    i = (i <= 0) ? jbState.playlist.length - 1 : i - 1; // loop reverso
    jbState.currentIndex = i;
    jbState.isPlaying = true;
    jbState.currentTime = 0;
    jbSave(jbState);
    jbio.emit("play_index", { index: i, seek: 0 });
    broadcastState();
  });

  socket.on("pause", () => {
    jbState.isPlaying = false;
    jbSave(jbState);
    jbio.emit("paused");
    // não precisa de broadcastState frequente aqui, mas mantemos coerência da UI
    broadcastState();
  });

  socket.on("resume", () => {
    jbState.isPlaying = true;
    jbSave(jbState);
    jbio.emit("resumed");
    broadcastState();
  });

  socket.on("set_volume", ({ volume } = {}) => {
    const v = clamp(Number(volume ?? jbState.volume), 0, 100);
    jbState.volume = v;
    jbSave(jbState);
    jbio.emit("volume", { volume: v });
    // não broadcastState para evitar ruído desnecessário
  });

  socket.on("seek_to", ({ seconds } = {}) => {
    const t = Math.max(0, Number(seconds || 0));
    jbState.currentTime = t;
    // salvar menos frequente seria bom; aqui salvamos leve
    jbSave(jbState);
    socket.broadcast.emit("seek", { seconds: t });
  });

  socket.on("remove_index", ({ index } = {}) => {
    if (!Array.isArray(jbState.playlist) || !jbState.playlist.length) return;
    index = clamp(Number(index ?? -1), 0, jbState.playlist.length - 1);
    const removingCurrent = index === jbState.currentIndex;
    jbState.playlist.splice(index, 1);
    if (!jbState.playlist.length){
      jbState.currentIndex = -1;
      jbState.isPlaying = false;
      jbState.currentTime = 0;
      toastAll("Playlist vazia.");
    } else {
      if (removingCurrent){
        // toca a próxima disponível (mesmo índice agora aponta para o próximo da lista)
        const next = Math.min(index, jbState.playlist.length - 1);
        jbState.currentIndex = next;
        jbState.isPlaying = true;
        jbState.currentTime = 0;
        jbio.emit("play_index", { index: next, seek: 0 });
      } else {
        // ajustar índice atual se item anterior foi removido
        if (index < jbState.currentIndex) jbState.currentIndex -= 1;
      }
    }
    jbSave(jbState);
    broadcastState();
  });

  socket.on("reorder", ({ from, to } = {}) => {
    if (!Array.isArray(jbState.playlist) || !jbState.playlist.length) return;
    from = clamp(Number(from ?? -1), 0, jbState.playlist.length - 1);
    to   = clamp(Number(to   ?? -1), 0, jbState.playlist.length - 1);
    if (from === to) return;
    jbState.playlist = moveItem(jbState.playlist, from, to);
    if (jbState.currentIndex === from) jbState.currentIndex = to;
    else if (from < jbState.currentIndex && to >= jbState.currentIndex) jbState.currentIndex -= 1;
    else if (from > jbState.currentIndex && to <= jbState.currentIndex) jbState.currentIndex += 1;
    jbSave(jbState);
    broadcastState();
  });

  socket.on("disconnect", () => { /* no-op */ });
});

// --- SPA fallback (mantém após rotas de API)
app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

httpServer.listen(PORT, () => {
  console.log(`Servidor no ar em http://localhost:${PORT}`);
});
