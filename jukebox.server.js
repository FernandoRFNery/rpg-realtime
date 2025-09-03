// jukebox.server.js
"use strict";
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

module.exports = function attachJukebox(io, dbFilePath) {
  const nsp = io.of("/jukebox");

  // ---------- DB ----------
  const db = new sqlite3.Database(dbFilePath || path.join(__dirname, "campaign.db"));
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS jb_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      videoId TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      badge TEXT,
      addedBy TEXT,
      position INTEGER NOT NULL
    );`);
    db.run(`CREATE TABLE IF NOT EXISTS jb_state (
      id INTEGER PRIMARY KEY CHECK (id=1),
      currentIndex INTEGER DEFAULT -1,
      isPlaying INTEGER DEFAULT 0,
      volume INTEGER DEFAULT 70,
      currentTime REAL DEFAULT 0,
      updatedAt TEXT DEFAULT (datetime('now'))
    );`);
    db.run(`INSERT OR IGNORE INTO jb_state (id) VALUES (1);`);
  });

  function snapshot() {
    try {
      const backupsDir = path.join(__dirname, "backups");
      if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dst = path.join(backupsDir, `campaign.db.${stamp}.bak`);
      fs.copyFileSync(dbFilePath, dst);
    } catch (e) { console.error("[Jukebox] Snapshot error:", e.message); }
  }
  setInterval(snapshot, 10 * 60 * 1000);

  // ---------- In-memory State ----------
  const state = {
    playlist: [],
    currentIndex: -1,
    isPlaying: false,
    volume: 70,
    currentTime: 0
  };

  function loadAll(cb) {
    db.all(`SELECT * FROM jb_tracks ORDER BY position ASC`, (err, rows) => {
      if (err) return cb(err);
      db.get(`SELECT * FROM jb_state WHERE id=1`, (err2, s) => {
        if (err2) return cb(err2);
        state.playlist = rows || [];
        state.currentIndex = s?.currentIndex ?? -1;
        state.isPlaying = !!(s?.isPlaying ?? 0);
        state.volume = s?.volume ?? 70;
        state.currentTime = s?.currentTime ?? 0;
        cb(null, state);
      });
    });
  }

  function saveState(partial = {}) {
    Object.assign(state, partial);
    db.run(
      `UPDATE jb_state SET currentIndex=?, isPlaying=?, volume=?, currentTime=?, updatedAt=datetime('now') WHERE id=1`,
      [state.currentIndex, state.isPlaying ? 1 : 0, state.volume, state.currentTime]
    );
  }

  // First load
  loadAll((err) => {
    if (err) console.error("[Jukebox] load error:", err);
    else console.log("[Jukebox] Loaded", state.playlist.length, "tracks");
  });

  function emitFullState() {
    nsp.emit("state", {
      playlist: state.playlist,
      currentIndex: state.currentIndex,
      isPlaying: state.isPlaying,
      volume: state.volume,
      currentTime: state.currentTime
    });
  }

  // ---------- Helpers ----------
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  function insertTrack({ videoId, url, title, badge, addedBy }, cb) {
    db.get(`SELECT COALESCE(MAX(position), -1) AS maxp FROM jb_tracks`, (err, row) => {
      if (err) return cb(err);
      const pos = (row?.maxp ?? -1) + 1;
      db.run(
        `INSERT INTO jb_tracks (videoId,url,title,badge,addedBy,position) VALUES (?,?,?,?,?,?)`,
        [videoId, url, title || null, badge || null, addedBy || null, pos],
        function (err2) {
          if (err2) return cb(err2);
          const id = this.lastID;
          state.playlist.push({ id, videoId, url, title, badge, addedBy, position: pos });
          cb(null, id);
        }
      );
    });
  }

  function removeAt(index) {
    const item = state.playlist[index];
    if (!item) return;
    db.run(`DELETE FROM jb_tracks WHERE id=?`, [item.id]);
    state.playlist.splice(index, 1);
    // reindex
    state.playlist.forEach((t, i) => {
      t.position = i;
      db.run(`UPDATE jb_tracks SET position=? WHERE id=?`, [i, t.id]);
    });
    if (state.currentIndex >= state.playlist.length) state.currentIndex = state.playlist.length - 1;
    saveState({});
  }

  function move(from, to) {
    if (from === to) return;
    from = clamp(from, 0, state.playlist.length - 1);
    to   = clamp(to,   0, state.playlist.length - 1);
    const [item] = state.playlist.splice(from, 1);
    state.playlist.splice(to, 0, item);
    state.playlist.forEach((t, i) => {
      t.position = i;
      db.run(`UPDATE jb_tracks SET position=? WHERE id=?`, [i, t.id]);
    });
    if (state.currentIndex === from) state.currentIndex = to;
    else if (from < state.currentIndex && to >= state.currentIndex) state.currentIndex--;
    else if (from > state.currentIndex && to <= state.currentIndex) state.currentIndex++;
    saveState({});
  }

  // ---------- Socket.IO ----------
  nsp.on("connection", (sock) => {
    sock.emit("toast", "Conectado ao Jukebox");
    sock.on("sync_request", () => {
      loadAll((err) => {
        if (err) return console.error(err);
        sock.emit("state", state);
      });
    });

    sock.on("add_track", (payload) => {
      const { url, videoId, badge } = payload || {};
      if (!url || !videoId) return;
      insertTrack({ url, videoId, badge, title: null, addedBy: sock.id }, (err) => {
        if (err) return console.error(err);
        emitFullState();
        snapshot();
      });
    });

    sock.on("remove_index", ({ index }) => {
      removeAt(Number(index));
      emitFullState();
      snapshot();
    });

    sock.on("reorder", ({ from, to }) => {
      move(Number(from), Number(to));
      emitFullState();
      snapshot();
    });

    sock.on("play_index", ({ index, seek = 0 }) => {
      index = clamp(Number(index), 0, state.playlist.length - 1);
      state.currentIndex = index;
      state.isPlaying = true;
      state.currentTime = clamp(Number(seek) || 0, 0, 60 * 60 * 6);
      saveState({});
      nsp.emit("play_index", { index, seek: state.currentTime });
    });

    sock.on("pause", () => {
      state.isPlaying = false;
      saveState({});
      nsp.emit("paused");
    });

    sock.on("resume", () => {
      state.isPlaying = true;
      saveState({});
      nsp.emit("resumed");
    });

    sock.on("skip_next", () => {
      if (state.playlist.length === 0) return;
      const next = state.currentIndex + 1 < state.playlist.length ? state.currentIndex + 1 : 0;
      state.currentIndex = next;
      state.isPlaying = true;
      state.currentTime = 0;
      saveState({});
      nsp.emit("play_index", { index: next, seek: 0 });
    });

    sock.on("skip_prev", () => {
      if (state.playlist.length === 0) return;
      const prev = state.currentIndex - 1 >= 0 ? state.currentIndex - 1 : state.playlist.length - 1;
      state.currentIndex = prev;
      state.isPlaying = true;
      state.currentTime = 0;
      saveState({});
      nsp.emit("play_index", { index: prev, seek: 0 });
    });

    sock.on("set_volume", ({ volume }) => {
      state.volume = clamp(Number(volume)||70, 0, 100);
      saveState({});
      nsp.emit("volume", { volume: state.volume });
    });

    sock.on("seek_to", ({ seconds }) => {
      state.currentTime = clamp(Number(seconds)||0, 0, 60*60*6);
      saveState({});
      nsp.emit("seek", { seconds: state.currentTime });
    });
  });

  return { nsp, state };
};

