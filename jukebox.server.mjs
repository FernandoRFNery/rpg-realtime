// jukebox.server.mjs  (ESM + better-sqlite3)
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

/**
 * Integra o Jukebox no Socket.IO e persiste em SQLite.
 * @param {import('socket.io').Server} io
 * @param {string} dbFilePath - caminho do campaign.db
 * @param {string} backupsDir - pasta de backups (ex.: ./backups)
 */
export default function attachJukebox(io, dbFilePath, backupsDir = path.join(process.cwd(), "backups")) {
  const nsp = io.of("/jukebox");

  const db = new Database(dbFilePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("wal_autocheckpoint = 1000");

  db.prepare(`
    CREATE TABLE IF NOT EXISTS jb_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      videoId TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      badge TEXT,
      addedBy TEXT,
      position INTEGER NOT NULL
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS jb_state (
      id INTEGER PRIMARY KEY CHECK (id=1),
      currentIndex INTEGER DEFAULT -1,
      isPlaying INTEGER DEFAULT 0,
      volume INTEGER DEFAULT 70,
      currentTime REAL DEFAULT 0,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  db.prepare(`INSERT OR IGNORE INTO jb_state (id) VALUES (1)`).run();

  const state = {
    playlist: [],
    currentIndex: -1,
    isPlaying: false,
    volume: 70,
    currentTime: 0
  };

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function snapshotNow() {
    try {
      if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dst = path.join(backupsDir, `campaign.db.${stamp}.bak`);
      fs.copyFileSync(dbFilePath, dst);
    } catch (e) {
      console.warn("[Jukebox] snapshot falhou:", e.message);
    }
  }

  function loadAll() {
    const rows = db.prepare(`SELECT * FROM jb_tracks ORDER BY position ASC`).all();
    const s = db.prepare(`SELECT * FROM jb_state WHERE id=1`).get();
    state.playlist = rows || [];
    state.currentIndex = s?.currentIndex ?? -1;
    state.isPlaying = !!(s?.isPlaying ?? 0);
    state.volume = s?.volume ?? 70;
    state.currentTime = s?.currentTime ?? 0;
  }

  function saveState(partial = {}) {
    Object.assign(state, partial);
    db.prepare(`
      UPDATE jb_state
         SET currentIndex = ?,
             isPlaying   = ?,
             volume      = ?,
             currentTime = ?,
             updatedAt   = datetime('now')
       WHERE id = 1
    `).run(state.currentIndex, state.isPlaying ? 1 : 0, state.volume, state.currentTime);
  }

  function emitFullState() {
    nsp.emit("state", {
      playlist: state.playlist,
      currentIndex: state.currentIndex,
      isPlaying: state.isPlaying,
      volume: state.volume,
      currentTime: state.currentTime
    });
  }

  function insertTrack({ videoId, url, title = null, badge = null, addedBy = null }) {
    const maxp = db.prepare(`SELECT COALESCE(MAX(position), -1) AS p FROM jb_tracks`).get()?.p ?? -1;
    const pos = maxp + 1;
    const info = db.prepare(`
      INSERT INTO jb_tracks (videoId,url,title,badge,addedBy,position)
      VALUES (?,?,?,?,?,?)
    `).run(videoId, url, title, badge, addedBy, pos);
    const id = info.lastInsertRowid;
    state.playlist.push({ id, videoId, url, title, badge, addedBy, position: pos });
  }

  function reindexAndPersist() {
    const upd = db.prepare(`UPDATE jb_tracks SET position=? WHERE id=?`);
    state.playlist.forEach((t, i) => { t.position = i; upd.run(i, t.id); });
  }

  function removeAt(index) {
    const item = state.playlist[index];
    if (!item) return;
    db.prepare(`DELETE FROM jb_tracks WHERE id=?`).run(item.id);
    state.playlist.splice(index, 1);
    reindexAndPersist();
    if (state.currentIndex >= state.playlist.length) state.currentIndex = state.playlist.length - 1;
    saveState();
  }

  function move(from, to) {
    if (!state.playlist.length) return;
    from = clamp(from, 0, state.playlist.length - 1);
    to   = clamp(to,   0, state.playlist.length - 1);
    if (from === to) return;
    const [it] = state.playlist.splice(from, 1);
    state.playlist.splice(to, 0, it);
    reindexAndPersist();

    if (state.currentIndex === from) state.currentIndex = to;
    else if (from < state.currentIndex && to >= state.currentIndex) state.currentIndex--;
    else if (from > state.currentIndex && to <= state.currentIndex) state.currentIndex++;
    saveState();
  }

  loadAll();
  setInterval(snapshotNow, 10 * 60 * 1000);

  nsp.on("connection", (sock) => {
    sock.emit("state", state);

    sock.on("sync_request", () => {
      loadAll();
      sock.emit("state", state);
    });

    sock.on("add_track", ({ url, videoId, badge }) => {
      if (!url || !videoId) return;
      insertTrack({ url, videoId, badge, addedBy: sock.id });
      emitFullState();
      snapshotNow();
    });

    sock.on("remove_index", ({ index }) => {
      removeAt(Number(index));
      emitFullState();
      snapshotNow();
    });

    sock.on("reorder", ({ from, to }) => {
      move(Number(from), Number(to));
      emitFullState();
      snapshotNow();
    });

    sock.on("play_index", ({ index, seek = 0 }) => {
      if (!state.playlist.length) return;
      index = clamp(Number(index), 0, state.playlist.length - 1);
      saveState({ currentIndex: index, isPlaying: true, currentTime: clamp(Number(seek) || 0, 0, 6 * 3600) });
      nsp.emit("play_index", { index, seek: state.currentTime });
    });

    sock.on("pause", () => {
      saveState({ isPlaying: false });
      nsp.emit("paused");
    });

    sock.on("resume", () => {
      saveState({ isPlaying: true });
      nsp.emit("resumed");
    });

    sock.on("skip_next", () => {
      if (!state.playlist.length) return;
      const next = state.currentIndex + 1 < state.playlist.length ? state.currentIndex + 1 : 0;
      saveState({ currentIndex: next, isPlaying: true, currentTime: 0 });
      nsp.emit("play_index", { index: next, seek: 0 });
    });

    sock.on("skip_prev", () => {
      if (!state.playlist.length) return;
      const prev = state.currentIndex - 1 >= 0 ? state.currentIndex - 1 : state.playlist.length - 1;
      saveState({ currentIndex: prev, isPlaying: true, currentTime: 0 });
      nsp.emit("play_index", { index: prev, seek: 0 });
    });

    sock.on("set_volume", ({ volume }) => {
      saveState({ volume: clamp(Number(volume) || 70, 0, 100) });
      nsp.emit("volume", { volume: state.volume });
    });

    sock.on("seek_to", ({ seconds }) => {
      saveState({ currentTime: clamp(Number(seconds) || 0, 0, 6 * 3600) });
      nsp.emit("seek", { seconds: state.currentTime });
    });
  });

  return { nsp, state };
}
