(function initDrakonPitch() {
  if (!window.__orcaTuneRuntimeBaseUrl) {
    const runtime = (typeof chrome !== "undefined" && chrome.runtime) || (typeof browser !== "undefined" && browser.runtime);
    if (runtime?.getURL) {
      window.__orcaTuneRuntimeBaseUrl = runtime.getURL("");
    }
  }

  let currentTone = 0;

  function isMiniPlayerVisible() {
    const mini = document.querySelector("ytd-miniplayer");
    if (!mini) return false;
    if (mini.hasAttribute("hidden")) return false;
    const style = window.getComputedStyle(mini);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = mini.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isInsideMiniPlayer(video) {
    return !!(video && typeof video.closest === "function" && video.closest("ytd-miniplayer"));
  }

  function findVideo() {
    const miniVisible = isMiniPlayerVisible();

    if (miniVisible) {
      const miniVideos = Array.from(document.querySelectorAll("ytd-miniplayer video"));
      const playingInMini = miniVideos.find((v) => !v.paused && v.readyState >= 2 && !v.ended);
      if (playingInMini) return playingInMini;
      const miniVid =
        document.querySelector("ytd-miniplayer video.video-stream") ||
        document.querySelector("ytd-miniplayer video");
      if (miniVid) return miniVid;
    }

    const mainSelectors = [
      "#movie_player video.video-stream",
      "#movie_player video",
      "video.html5-main-video"
    ];
    for (const sel of mainSelectors) {
      const v = document.querySelector(sel);
      if (v && !isInsideMiniPlayer(v)) return v;
    }

    const rest = Array.from(document.querySelectorAll("video")).filter((v) => !isInsideMiniPlayer(v));
    const active = rest.find((v) => !v.paused && v.readyState >= 2 && !v.ended);
    return active || rest[0] || null;
  }

  async function syncGraphAndTone(video, semitones) {
    if (!window.__orcaTuneAudioGraph) return;
    const graph = window.__orcaTuneAudioGraph;

    if (semitones !== 0) graph._activated = true;
    if (!video) return;
    if (!graph._activated) return;

    const videoChanged = graph.video != null && graph.video !== video;

    await graph.ensureGraph(video, { forceReconnect: videoChanged });
    await graph.setTone(semitones);
    await graph.resumeAudioContext();
  }

  async function applyTone(semitones) {
    if (!window.__orcaTuneAudioGraph) {
      throw new Error("Audio engine not ready");
    }
    await syncGraphAndTone(findVideo(), semitones);
    currentTone = semitones;
  }

  let rebindDebounceTimer = null;
  async function rebindIfVideoSwapped() {
    const graph = window.__orcaTuneAudioGraph;
    if (!graph || !graph._activated) return;
    const video = findVideo();
    if (!video || graph.video === video) return;
    await syncGraphAndTone(video, currentTone);
  }

  function scheduleVideoRebindCheck() {
    clearTimeout(rebindDebounceTimer);
    rebindDebounceTimer = setTimeout(() => {
      rebindIfVideoSwapped().catch(() => {});
    }, 120);
  }

  setInterval(() => {
    rebindIfVideoSwapped().catch(() => {});
  }, 450);

  window.addEventListener("yt-navigate-finish", scheduleVideoRebindCheck);
  document.addEventListener("yt-page-data-updated", scheduleVideoRebindCheck);

  // Listen for messages from popup
  const runtime = (typeof chrome !== "undefined" && chrome.runtime) || (typeof browser !== "undefined" && browser.runtime);
  let setToneQueue = Promise.resolve();
  if (runtime?.onMessage) {
    runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "drakonpitch:set-tone") {
        const semitones = Number(msg.tone ?? 0);
        setToneQueue = setToneQueue
          .catch(() => {})
          .then(async () => {
            try {
              await applyTone(semitones);
              sendResponse({ ok: true, tone: currentTone });
            } catch (err) {
              sendResponse({
                ok: false,
                error: String(err?.message != null ? err.message : err)
              });
            }
          });
        return true;
      }
      if (msg?.type === "drakonpitch:get-tone") {
        sendResponse({ tone: currentTone });
        return false;
      }
    });
  }

  // Resume audio context on visibility change
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    window.__orcaTuneAudioGraph?.resumeAudioContext?.().catch(() => {});
  });
})();
