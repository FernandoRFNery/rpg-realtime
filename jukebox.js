<script>
// public/jukebox.js
(() => {
  "use strict";

  // ==========================
  // Config
  // ==========================
  const NAMESPACE = "/jukebox";
  const BTN_ID = "jb-open-btn";
  const MODAL_ID = "jb-modal";
  const LIST_SEL = ".jb-list";
  const STORAGE_NS = "dmw_jukebox_";
  const YT_IFRAME_ID = "jbYT";

  // ==========================
  // Utilities
  // ==========================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
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

  // ==========================
  // Socket + State
  // ==========================
  let socket;
  let state = {
    playlist: [],         // [{id, videoId, url, title, badge, addedBy, position}]
    currentIndex: -1,
    isPlaying: false,
    volume: 70,
    currentTime: 0
  };

  // ==========================
  // YouTube API
  // ==========================
  let ytPlayer;
  let ytReady = false;
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
      playerVars: { rel: 0, controls: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          ytReady = true;
          ytPlayer.setVolume(state.volume);
        },
        onStateChange: (e) => {
          // 1: playing, 2: paused, 0: ended
          if (e.data === 1) {
            // update title from player, if missing
            const data = ytPlayer.getVideoData?.();
            if (data?.title) {
              const cur = state.playlist[state.currentIndex];
              if (cur && !cur.title) {
                cur.title = data.title;
                renderList();
              }
            }
          }
          if (e.data === 0) {
            socket.emit("skip_next");
          }
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

  // ==========================
  // DOM (modal, styles, controls)
  // ==========================
  function injectStyles() {
    if ($("#jb-styles")) return;
    const css = `
#${BTN_ID}{position:fixed;top:10px;right:10px;z-index:9999;padding:.5rem .75rem;border-radius:.75rem;background:#111;color:#fff;border:1px solid #333;cursor:pointer}
#${BTN_ID}:hover{background:#1b1b1b}
#${MODAL_ID}{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;z-index:9998}
#${MODAL_ID}.open{display:block}
#${MODAL_ID} .jb-dialog{position:absolute;inset:auto;top:5%;left:50%;transform:translateX(-50%);width:min(980px,94vw);background:#0b0b0c;border:1px solid #2a2a2a;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.45);padding:16px;color:#ddd}
#${MODAL_ID} .jb-header{display:flex;align-items:center;gap:.5rem;justify-content:space-between;margin-bottom:.5rem}
#${MODAL_ID} .jb-title{font-weight:700;font-size:1.05rem}
#${MODAL_ID} .jb-close{background:transparent;color:#aaa;border:none;font-size:20px;cursor:pointer}
#${MODAL_ID} .jb-row{display:flex;gap:.5rem;align-items:center;margin:.5rem 0;flex-wrap:wrap}
#${MODAL_ID} input[type=text]{flex:1;min-width:220px;background:#101014;color:#ddd;border:1px solid #2a2a2a;border-radius:10px;padding:.5rem .6rem}
#${MODAL_ID} .jb-btn{background:#18181b;border:1px solid #2a2a2a;color:#ddd;border-radius:10px;padding:.45rem .7rem;cursor:pointer}
#${MODAL_ID} .jb-btn:hover{background:#202024}
#${MODAL_ID} .jb-player{display:flex;gap:12px;align-items:center}
#${MODAL_ID} .jb-ctrl{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
#${MODAL_ID} .jb-list{margin-top:.75rem;max-height:52vh;overflow:auto;border:1px solid #202020;border-radius:12px;background:#0e0e10}
#${MODAL_ID} .jb-item{display:grid;grid-template-columns:42px 1fr auto auto;gap:.5rem;align-items:center;padding:.45rem .6rem;border-bottom:1px solid #141416}
#${MODAL_ID} .jb-item:last-child{border-bottom:none}
#${MODAL_ID} .jb-n{opacity:.7}
#${MODAL_ID} .jb-titleline{display:flex;gap:.5rem;align-items:center}
#${MODAL_ID} .jb-badge{font-size:.72rem;background:#1a1f2e;border:1px solid #24314f;color:#b7c7ff;padding:.15rem .4rem;border-radius:.5rem}
#${MODAL_ID} .playing{outline:2px solid #f4d03f;outline-offset:-2px;border-radius:8px}
.range{accent-color:#f4d03f}
.hide{display:none}
    `.trim();
    document.head.append(h("style",{id:"jb-styles"},css));
  }

  function ensureOpenButton() {
    if (document.getElementById(BTN_ID)) return;
    document.body.append(
      h("button",{id:BTN_ID,onclick:openModal},"Trilha Sonora")
    );
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
          h("input",{id:"jb-url",type:"text",placeholder:"Cole um link do YouTube..."}),
          h("input",{id:"jb-badge",type:"text",placeholder:"Badge (opcional)"}),
          h("button",{class:"jb-btn",id:"jb-add",onclick:addFromInput},"Adicionar")
        ),
        h("div",{class:"jb-row jb-player"},
          h("div",{style:"flex:1"},
            h("div",{id:"yt-wrap",style:"aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden;border:1px solid #202020"},
              h("div",{id:YT_IFRAME_ID})
            )
          ),
          h("div",{class:"jb-ctrl"},
            h("button",{class:"jb-btn",id:"jb-play",onclick:togglePlayPause},"▶︎/❚❚"),
            h("button",{class:"jb-btn",id:"jb-prev",onclick:()=>socket.emit('skip_prev')},"⏮"),
            h("button",{class:"jb-btn",id:"jb-next",onclick:()=>socket.emit('skip_next')},"⏭"),
            h("div",{style:"display:flex;align-items:center;gap:.4rem"},
              h("span",{id:"jb-time"},"0:00"),
              h("input",{id:"jb-seek",type:"range",min:"0",max:"100",value:"0",class:"range",oninput:(e)=>seekPreview(e)}),
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

    // time ticker (client side UI only)
    setInterval(() => {
      if (ytPlayer && state.isPlaying) {
        try {
          const cur = ytPlayer.getCurrentTime?.() || 0;
          const dur = ytPlayer.getDuration?.() || 0;
          $("#jb-time").textContent = fmtTime(cur);
          $("#jb-dur").textContent = fmtTime(dur);
          if (dur > 0) $("#jb-seek").value = String(Math.min(100, Math.floor((cur/dur)*100)));
        } catch {}
      }
    }, 500);
  }

  function openModal(){ $("#"+MODAL_ID).classList.add("open"); }
  function closeModal(){ $("#"+MODAL_ID).classList.remove("open"); }

  function addFromInput(){
    const url = $("#jb-url").value.trim();
    const badge = $("#jb-badge").value.trim();
    const vid = ytIdFromUrl(url);
    if (!vid) { alert("Link do YouTube inválido."); return; }
    socket.emit("add_track",{ url, videoId: vid, badge: badge || null });
    $("#jb-url").value=""; $("#jb-badge").value="";
  }

  function togglePlayPause(){
    if (state.isPlaying) socket.emit("pause");
    else socket.emit("resume");
  }

  function setVolumeLocal(v){
    state.volume = v;
    if (ytPlayer) try { ytPlayer.setVolume(v); } catch {}
  }

  function seekPreview(e){
    const v = Number(e.target.value);
    const dur = ytPlayer?.getDuration?.() || 0;
    const t = Math.floor((v/100)*dur);
    $("#jb-time").textContent = fmtTime(t);
    if (e.isTrusted && dur > 0 && ytPlayer) {
      socket.emit("seek_to",{ seconds: t });
    }
  }

  // ==========================
  // List rendering
  // ==========================
  function renderList(){
    const list = $("#jb-list");
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

  // ==========================
  // Socket wiring
  // ==========================
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

    socket.on("state", (s) => {
      state = Object.assign(state, s || {});
      renderList();
      if (ytReady && state.currentIndex >= 0 && state.playlist[state.currentIndex]) {
        const curId = ytPlayer?.getVideoData?.().video_id;
        const want = state.playlist[state.currentIndex].videoId;
        if (curId !== want) loadAndPlay(state.currentIndex, state.currentTime || 0);
        if (state.isPlaying) ytPlayer.playVideo?.(); else ytPlayer.pauseVideo?.();
        setVolumeLocal(state.volume);
      }
    });

    socket.on("play_index", ({index, seek=0}) => {
      if (ytReady) loadAndPlay(index, seek);
      state.currentIndex = index;
      state.isPlaying = true;
      renderList();
    });

    socket.on("paused", () => {
      state.isPlaying = false;
      ytPlayer?.pauseVideo?.();
    });

    socket.on("resumed", () => {
      state.isPlaying = true;
      ytPlayer?.playVideo?.();
    });

    socket.on("volume", ({volume}) => {
      setVolumeLocal(volume);
      $("#jb-vol").value = String(volume);
    });

    socket.on("seek", ({seconds}) => {
      try { ytPlayer?.seekTo?.(seconds, true); } catch {}
    });

    socket.on("toast", (m) => console.log("[Jukebox]", m));
  }

  // ==========================
  // Init
  // ==========================
  function init(){
    injectStyles();
    ensureOpenButton();
    buildModal();
    ensureYouTubeAPI().then(() => {
      createYTPlayer();
      connectSocket();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else init();

})();
</script>

