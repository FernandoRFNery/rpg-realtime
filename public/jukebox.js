(() => {
  "use strict";

  const NAMESPACE = "/jukebox";
  const BTN_ID = "jb-open-btn";
  const MODAL_ID = "jb-modal";
  const YT_IFRAME_ID = "jbYT";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const h = (tag, attrs = {}, ...kids) => {
    if (attrs == null || typeof attrs !== 'object' || Array.isArray(attrs)) attrs = {};
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    });
    kids.flat().forEach(k => {
      if (k == null) return;
      if (typeof k === "string") el.append(document.createTextNode(k));
      else el.append(k);
    });
    return el;
  };

  const ytIdFromUrl = (url) => {
    if (!url) return null;
    try {
      const u = new URL(url);
      if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const m = u.pathname.match(/\/embed\/([a-zA-Z0-9_-]{6,})/);
      return m ? m[1] : null;
    } catch { return null; }
  };

  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const m = Math.floor(s / 60);
    const r = String(s % 60).padStart(2, "0");
    return `${m}:${r}`;
  };

  // --- small util: debounce emits that may be noisy (seek) ---
  const debounce = (fn, ms=150) => {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  let socket;
  let state = {
    playlist: [],
    currentIndex: -1,
    isPlaying: false,
    volume: 70,
    currentTime: 0
  };

  let ytPlayer;
  let ytReady = false;
  let jbUnlocked = false;  // libera autoplay após 1 gesto do usuário

  function ensureYouTubeAPI() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    return new Promise(res => {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      window.onYouTubeIframeAPIReady = () => res();
      document.head.appendChild(s);
    });
  }

  function createYTPlayer() {
    if (ytPlayer) return;
    ytPlayer = new YT.Player(YT_IFRAME_ID, {
      height: "315",
      width: "560",
      host: "https://www.youtube.com",
      playerVars: { rel: 0, controls: 0, modestbranding: 1, playsinline: 1, origin: location.origin },
      events: {
        onReady: () => {
          ytReady = true;
          try {
            const ifr = ytPlayer.getIframe && ytPlayer.getIframe();
            if (ifr) ifr.setAttribute('allow','autoplay; encrypted-media; clipboard-write; picture-in-picture');
          } catch {}
          ytPlayer.setVolume(state.volume);
        },
        onStateChange: (e) => {
          // quando o player local trocar para "playing", capture o título
          if (e.data === 1) {
            const data = ytPlayer.getVideoData?.();
            if (data?.title) {
              const cur = state.playlist[state.currentIndex];
              if (cur && !cur.title) {
                cur.title = data.title;
                renderList();
              }
            }
          }
          // quando o vídeo terminar, peça o próximo ao servidor
          if (e.data === 0) {
            socket?.emit("skip_next");
          }
        },
        onError: (e) => {
          console.warn('[YT error]', e?.data);
        }
      }
    });
  }

  function loadAndPlay(index, seek = 0) {
    const item = state.playlist[index];
    if (!item || !ytReady) return;
    state.currentIndex = index;
    if (seek > 0) ytPlayer.loadVideoById({ videoId: item.videoId, startSeconds: seek });
    else ytPlayer.loadVideoById(item.videoId);
    ytPlayer.setVolume(state.volume);
  }

  function injectStyles() {
    if (document.getElementById("jb-styles")) return;
    const T = Object.assign({
      primary: "#0b0c0e",
      surface: "#0f1115",
      surfaceElev: "#11141a",
      border: "#2a2f3a",
      borderSoft: "#1c212b",
      accent: "#f5d76e",
      accentSoft: "#c7a84f",
      text: "#e6e6e6",
      textDim: "#aab0bf",
      badgeBg: "#161a24",
      badgeBd: "#22304a",
      badgeTx: "#c7d3ff",
      shadow: "rgba(0,0,0,.55)"
    }, (window.JukeboxTheme || {}));

    const css = `
:root {
  --jb-primary:${T.primary};
  --jb-surface:${T.surface};
  --jb-surface-elev:${T.surfaceElev};
  --jb-border:${T.border};
  --jb-border-soft:${T.borderSoft};
  --jb-accent:${T.accent};
  --jb-accent-soft:${T.accentSoft};
  --jb-text:${T.text};
  --jb-text-dim:${T.textDim};
  --jb-badge-bg:${T.badgeBg};
  --jb-badge-bd:${T.badgeBd};
  --jb-badge-tx:${T.badgeTx};
  --jb-shadow:${T.shadow};
}
@keyframes jb-fade-in { from { opacity:0; transform: translateY(6px); } to { opacity:1; transform:none; } }
@keyframes jb-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(245,215,110,.35);} 50% { box-shadow: 0 0 0 6px rgba(245,215,110,0);} }

#${MODAL_ID}{ position:fixed; inset:0; background:rgba(0,0,0,.65); backdrop-filter:saturate(110%) blur(2px); display:none; z-index:9998; padding:4vh 2vw; overflow:auto; }
#${MODAL_ID}.open{ display:flex; align-items:flex-start; justify-content:center; }
#${MODAL_ID} .jb-dialog{
  position:relative;
  width:min(1000px,96vw);
  max-height:92vh; overflow:hidden;
  background: radial-gradient(1200px 600px at 10% -20%, rgba(245,215,110,.06), transparent 40%) , var(--jb-surface);
  border:1px solid var(--jb-border);
  border-radius:18px; box-shadow:0 20px 60px var(--jb-shadow);
  padding:16px; color:var(--jb-text); animation: jb-fade-in .18s ease-out both;
}
#${MODAL_ID} .jb-header{
  display:flex; align-items:center; justify-content:space-between;
  padding:4px 6px 8px 6px; border-bottom:1px solid var(--jb-border-soft); margin-bottom:.35rem;
}
#${MODAL_ID} .jb-title{ font-weight:800; font-size:1.05rem; letter-spacing:.3px; }
#${MODAL_ID} .jb-close{ background:transparent; color:var(--jb-text-dim); border:none; font-size:20px; cursor:pointer; padding:.2rem .4rem; border-radius:8px; }
#${MODAL_ID} .jb-close:hover{ background:var(--jb-surface-elev); color:var(--jb-text); }

#${MODAL_ID} .jb-row{ display:flex; gap:.6rem; align-items:center; margin:.55rem 0; flex-wrap:wrap; }
#${MODAL_ID} input[type=text]{
  flex:1; min-width:220px; background:var(--jb-primary); color:var(--jb-text);
  border:1px solid var(--jb-border); border-radius:12px; padding:.6rem .7rem; outline:none;
}
#${MODAL_ID} input[type=text]:focus{ border-color:var(--jb-accent-soft); box-shadow:0 0 0 3px rgba(245,215,110,.12); }

#${MODAL_ID} .jb-btn{
  background:linear-gradient(180deg, var(--jb-surface-elev), var(--jb-primary));
  border:1px solid var(--jb-border); color:var(--jb-text);
  border-radius:12px; padding:.5rem .75rem; cursor:pointer; font-weight:600;
  transition: background .15s ease, transform .06s ease, box-shadow .15s ease;
}
#${MODAL_ID} .jb-btn:hover{ background:var(--jb-surface-elev); }
#${MODAL_ID} .jb-btn:active{ transform: translateY(1px); }

#${MODAL_ID} .jb-player{ display:flex; gap:12px; align-items:center; }
#${MODAL_ID} #yt-wrap{
  aspect-ratio:16/9; background:#000; border-radius:14px; overflow:hidden;
  border:1px solid var(--jb-border-soft); box-shadow: inset 0 0 0 1px rgba(255,255,255,.02);
}

#${MODAL_ID} .jb-ctrl{ display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
#${MODAL_ID} .jb-ctrl > .jb-btn{ min-width:46px; text-align:center; }

#${MODAL_ID} .jb-list{
  margin-top:.7rem; max-height:52vh; overflow:auto;
  border:1px solid var(--jb-border); border-radius:14px; background:var(--jb-primary);
}
#${MODAL_ID} .jb-item{
  display:grid; grid-template-columns:56px 1fr auto auto; gap:.6rem; align-items:center;
  padding:.55rem .7rem; border-bottom:1px solid var(--jb-border-soft);
  transition: background .12s ease;
}
#${MODAL_ID} .jb-item:hover{ background:var(--jb-surface-elev); }
#${MODAL_ID} .jb-item:last-child{ border-bottom:none; }
#${MODAL_ID} .jb-n{ opacity:.8; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
#${MODAL_ID} .jb-titleline{ display:flex; gap:.5rem; align-items:center; line-height:1.25; }
#${MODAL_ID} .jb-badge{
  font-size:.72rem; background:var(--jb-badge-bg); border:1px solid var(--jb-badge-bd);
  color:var(--jb-badge-tx); padding:.15rem .4rem; border-radius:.5rem; letter-spacing:.2px;
}
#${MODAL_ID} .playing{
  outline:2px solid var(--jb-accent); outline-offset:-2px; border-radius:10px;
  animation: jb-pulse 1.8s ease-in-out infinite;
}

.range{ accent-color: var(--jb-accent); }
#${MODAL_ID} input[type=range]{ height: 4px; }
#${MODAL_ID} input[type=range]::-webkit-slider-runnable-track{
  height:4px; background:linear-gradient(90deg, var(--jb-accent) 0, var(--jb-accent) 0), var(--jb-border-soft);
  border-radius:999px;
}
#${MODAL_ID} input[type=range]::-webkit-slider-thumb{
  -webkit-appearance:none; appearance:none; width:14px; height:14px; border-radius:50%;
  background: var(--jb-accent); border:1px solid #a3862f; margin-top:-5px;
}
#${MODAL_ID} ::-webkit-scrollbar{ width:10px; }
#${MODAL_ID} ::-webkit-scrollbar-thumb{ background: #181c24; border:1px solid var(--jb-border); border-radius:999px; }
#${MODAL_ID} ::-webkit-scrollbar-track{ background: transparent; }
    `.trim();

    document.head.append(Object.assign(document.createElement("style"), { id:"jb-styles", textContent: css }));
  }

  function ensureOpenButton() {
    if (document.getElementById(BTN_ID)) return;
    const container = document.getElementById("actions-bar") || document.querySelector("header .toolbar") || document.body;
    const btn = h("button",{id:BTN_ID,onclick:openModal,class:"btn"},"Trilha Sonora");
    container.append(btn);
  }

  function buildModal() {
    if (document.getElementById(MODAL_ID)) return;
    const modal = h("div",{id:MODAL_ID,onclick:(e)=>{ if(e.target.id===MODAL_ID) closeModal(); }},
      h("div",{class:"jb-dialog"},
        h("div",{class:"jb-header"},
          h("div",{class:"jb-title"},"Jukebox"),
          h("button",{class:"jb-close",title:"Fechar",onclick:closeModal},"✕")
        ),
        h("div",{class:"jb-row"},
          h("input",{id:"jb-url",type:"text",placeholder:"Cole um link do YouTube (ex.: https://youtu.be/ID)..."}),
          h("input",{id:"jb-badge",type:"text",placeholder:"Badge (opcional)"}),
          h("button",{class:"jb-btn",id:"jb-add",onclick:addFromInput},"Adicionar ♪")
        ),
        h("div",{class:"jb-row jb-player"},
          h("div",{style:"flex:1"},
            h("div",{id:"yt-wrap"},
              h("div",{id:YT_IFRAME_ID})
            )
          ),
          h("div",{class:"jb-ctrl"},
            h("button",{class:"jb-btn",id:"jb-play",onclick:togglePlayPause,title:"Play/Pause"},"▶︎/❚❚"),
            h("button",{class:"jb-btn",id:"jb-prev",onclick:()=>socket.emit('skip_prev'),title:"Anterior"},"⏮"),
            h("button",{class:"jb-btn",id:"jb-next",onclick:()=>socket.emit('skip_next'),title:"Próxima"},"⏭"),
            h("div",{style:"display:flex;align-items:center;gap:.4rem"},
              h("span",{id:"jb-time"},"0:00"),
              h("input",{id:"jb-seek",type:"range",min:"0",max:"100",value:"0",class:"range",oninput:(e)=>seekPreview(e), onchange:(e)=>seekCommit(e)}),
              h("span",{id:"jb-dur"},"0:00")
            ),
            h("div",{style:"display:flex;align-items:center;gap:.4rem"},
              h("span","🔊"),
              h("input",{id:"jb-vol",type:"range",min:"0",max:"100",value:String(state.volume),class:"range",
                oninput:(e)=>setVolumeLocal(Number(e.target.value)),
                onchange:(e)=>socket.emit("set_volume",{volume:Number(e.target.value)})})
            )
          )
        ),
        h("div",{class:"jb-list",id:"jb-list"})
      )
    );
    document.body.append(modal);

    setInterval(() => {
      if (ytPlayer && ytReady) {
        try {
          const cur = ytPlayer.getCurrentTime?.() || 0;
          const dur = ytPlayer.getDuration?.() || 0;
          $("#jb-time").textContent = fmtTime(cur);
          $("#jb-dur").textContent = fmtTime(dur);
          if (dur > 0) $("#jb-seek").value = String(Math.min(100, Math.floor((cur/dur)*100)));
        } catch {}
      }
    }, 500);

    document.addEventListener("keydown", (e) => {
      const open = document.getElementById(MODAL_ID)?.classList.contains("open");
      if (!open) return;
      const activeIsInput = /input|textarea/i.test(document.activeElement?.tagName || "");
      if (activeIsInput) return;
      if (e.code === "Space") { e.preventDefault(); togglePlayPause(); }
      if (e.key === "ArrowRight") socket.emit("seek_to", { seconds: (ytPlayer?.getCurrentTime?.() || 0) + 5 });
      if (e.key === "ArrowLeft")  socket.emit("seek_to", { seconds: Math.max(0,(ytPlayer?.getCurrentTime?.() || 0) - 5) });
      if (e.key === "ArrowUp")    { e.preventDefault(); const v = Math.min(100, (state.volume||0)+5); $("#jb-vol").value = String(v); socket.emit("set_volume",{volume:v}); }
      if (e.key === "ArrowDown")  { e.preventDefault(); const v = Math.max(0, (state.volume||0)-5);  $("#jb-vol").value = String(v); socket.emit("set_volume",{volume:v}); }
    });
  }

  function openModal(){ $("#"+MODAL_ID).classList.add("open"); }
  function closeModal(){ $("#"+MODAL_ID).classList.remove("open"); }

  function addFromInput(){
    const url = $("#jb-url").value.trim();
    const badge = $("#jb-badge").value.trim();
    const vid = ytIdFromUrl(url);
    if (!vid) { alert("Link do YouTube inválido."); return; }
    const newItem = { url, videoId: vid, badge: badge || null, title: "" };
    state.playlist.push(newItem);
    renderList();
    if (typeof socket !== "undefined" && socket) socket.emit("add_track", newItem);
    $("#jb-url").value=""; $("#jb-badge").value="";
  }

  function unlockIfNeededFromGesture(){
    // Só tenta desbloquear se ainda não conseguiu e se há player pronto
    if (jbUnlocked || !ytPlayer || !ytReady) return;
    try {
      const ifr = ytPlayer.getIframe && ytPlayer.getIframe();
      if (ifr) ifr.setAttribute('allow','autoplay; encrypted-media; clipboard-write; picture-in-picture');
    } catch {}
    try {
      ytPlayer.mute();
      ytPlayer.playVideo();
      setTimeout(() => { try{ ytPlayer.pauseVideo(); ytPlayer.unMute(); jbUnlocked = true; }catch{} }, 80);
      // se falhar, jbUnlocked continua false e tentaremos novamente no próximo gesto
    } catch { /* ignore */ }
  }

  function togglePlayPause(){
    if (!ytReady) return;
    if (state.isPlaying) {
      socket?.emit("pause");
      try { ytPlayer?.pauseVideo?.(); } catch {}
      state.isPlaying = false;
    } else {
      unlockIfNeededFromGesture();
      // se nada estiver selecionado ainda, comece a playlist (índice 0)
      if (state.currentIndex < 0 && state.playlist.length > 0) {
        socket?.emit("play_index",{ index: 0, seek: 0 });
      } else {
        // garante que o vídeo correto esteja carregado antes de tocar
        const want = state.playlist[state.currentIndex];
        const curId = ytPlayer?.getVideoData?.().video_id;
        if (want && curId !== want.videoId) loadAndPlay(state.currentIndex, state.currentTime || 0);
        try { ytPlayer?.playVideo?.(); } catch {}
        socket?.emit("resume");
      }
      state.isPlaying = true;
      renderList();
    }
  }

  function setVolumeLocal(v){
    state.volume = v;
    try { ytPlayer?.setVolume?.(v); } catch {}
  }

  const emitSeekDebounced = debounce((seconds) => socket?.emit("seek_to",{ seconds }), 120);

  function seekPreview(e){
    const v = Number(e.target.value);
    const dur = ytPlayer?.getDuration?.() || 0;
    const t = Math.floor((v/100)*dur);
    $("#jb-time").textContent = fmtTime(t);
    if (e.isTrusted && dur > 0 && ytPlayer) {
      emitSeekDebounced(t);
    }
  }
  function seekCommit(e){
    const v = Number(e.target.value);
    const dur = ytPlayer?.getDuration?.() || 0;
    if (dur > 0) {
      const t = Math.floor((v/100)*dur);
      socket?.emit("seek_to",{ seconds: t });
    }
  }

  function renderList(){
    const list = $("#jb-list");
    if (!list) return;
    list.innerHTML = "";
    state.playlist.forEach((item, idx) => {
      const row = h("div",{class:"jb-item"+(idx===state.currentIndex?" playing":""), "data-idx":idx},
        h("div",{class:"jb-n"}, String(idx+1).padStart(2,"0")),
        h("div",{class:"jb-titleline"},
          h("div",{style:"font-weight:600"}, item.title || "(carregando título...)"),
          item.badge ? h("span",{class:"jb-badge"}, item.badge) : null
        ),
        h("div",{},
          h("button",{class:"jb-btn",title:"Tocar",onclick:()=>socket.emit("play_index",{index:idx})},"▶︎"),
          h("button",{class:"jb-btn",title:"↑",onclick:()=>socket.emit("reorder",{from:idx,to:Math.max(0,idx-1)})},"↑"),
          h("button",{class:"jb-btn",title:"↓",onclick:()=>socket.emit("reorder",{from:idx,to:Math.min(state.playlist.length-1,idx+1)})},"↓")
        ),
        h("div",{},
          h("button",{class:"jb-btn",title:"Remover",onclick:()=>socket.emit("remove_index",{index:idx})},"🗑")
        )
      );
      list.append(row);
    });
  }

  function connectSocket(){
    if (!window.io) {
      const s = document.createElement("script");
      s.src = "/socket.io/socket.io.js";
      s.onload = boot;
      document.head.appendChild(s);
      return;
    }
    boot();
  }

  function boot(){
    socket = io(NAMESPACE, { transports: ["websocket","polling"] });

    socket.on("connect", () => {
      socket.emit("sync_request");
    });

    socket.on("state", (incoming) => {
      // mescla estado, mas evita reiniciar o vídeo sem necessidade
      state = Object.assign(state, incoming || {});
      renderList();

      if (!ytReady || state.currentIndex < 0 || !state.playlist[state.currentIndex]) return;

      const curId = ytPlayer?.getVideoData?.().video_id;
      const want = state.playlist[state.currentIndex].videoId;
      const desiredTime = Math.max(0, Number(state.currentTime || 0));
      const localTime = Math.max(0, Number(ytPlayer?.getCurrentTime?.() || 0));
      const delta = Math.abs(localTime - desiredTime);

      if (curId !== want) {
        // carrega outro vídeo só se o ID divergir
        loadAndPlay(state.currentIndex, desiredTime);
      } else {
        // apenas sincroniza o tempo se estiver muito fora (~>1.5s)
        if (delta > 1.5) { try { ytPlayer?.seekTo?.(desiredTime, true); } catch {} }
      }

      // aplica o status de play/pause sem recarregar
      if (state.isPlaying) { try { ytPlayer?.playVideo?.(); } catch {} }
      else { try { ytPlayer?.pauseVideo?.(); } catch {} }

      setVolumeLocal(state.volume);
    });

    socket.on("play_index", ({index, seek=0}) => {
      if (ytReady) { loadAndPlay(index, seek); try{ ytPlayer.playVideo(); }catch{} }
      state.currentIndex = index;
      state.isPlaying = true;
      state.currentTime = seek || 0;
      renderList();
    });

    socket.on("paused", () => {
      state.isPlaying = false;
      ytPlayer?.pauseVideo?.();
    });

    socket.on("resumed", () => {
      state.isPlaying = true;
      try { ytPlayer?.playVideo?.(); } catch {}
    });

    socket.on("volume", ({volume}) => {
      setVolumeLocal(volume);
      const vol = document.getElementById("jb-vol");
      if (vol) vol.value = String(volume);
    });

    socket.on("seek", ({seconds}) => {
      try { ytPlayer?.seekTo?.(seconds, true); } catch {}
      state.currentTime = seconds || 0;
    });

    socket.on("toast", (m) => console.log("[Jukebox]", m));
  }

  function init(){
    injectStyles();
    ensureOpenButton();
    buildModal();
    ensureYouTubeAPI().then(() => {
      createYTPlayer();
      connectSocket();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

})();