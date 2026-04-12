(function initOrcaTuneUI() {
  if (!window.__orcaTuneRuntimeBaseUrl) {
    const runtime = (typeof chrome !== "undefined" && chrome.runtime) || (typeof browser !== "undefined" && browser.runtime);
    if (runtime?.getURL) {
      window.__orcaTuneRuntimeBaseUrl = runtime.getURL("");
    }
  }

  const ROOT_ID = "orcatune-root";
  let observer = null;
  let slider = null;
  let valueText = null;
  let lastMiniPrimary = undefined;
  let rebindGeneration = 0;

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

  function findContainer() {
    return (
      document.querySelector("#above-the-fold #title") ||
      document.querySelector("#info") ||
      document.querySelector("ytd-watch-metadata") ||
      document.body
    );
  }

  async function syncGraphAndTone(video, semitones) {
    if (!video || !window.__orcaTuneAudioGraph) return;
    const graph = window.__orcaTuneAudioGraph;

    // Explicit activation: only allow audio capture after user sets a non-zero tone.
    // This is the primary guard; graph._activated is the secondary hard gate.
    if (semitones !== 0) graph._activated = true;
    if (!graph._activated) return;

    const nowMiniPrimary = isInsideMiniPlayer(video);
    const miniFlipped =
      lastMiniPrimary !== undefined && lastMiniPrimary !== nowMiniPrimary;
    lastMiniPrimary = nowMiniPrimary;
    const videoChanged = graph.video != null && graph.video !== video;
    // MediaElementSource connection survives DOM moves (mini↔full with same element).
    // Only force-reconnect when the video element reference actually changes.
    const forceReconnect = videoChanged;
    await graph.ensureGraph(video, { forceReconnect });
    await graph.setTone(semitones);
    await graph.resumeAudioContext();
  }

  async function onSliderInput(event) {
    const value = Number(event.target.value);
    await syncGraphAndTone(findVideo(), value);
  }

  async function applyCurrentToneToCurrentVideo() {
    if (!slider) return;
    await syncGraphAndTone(findVideo(), Number(slider.value));
  }

  function updateValueLabel() {
    if (!slider || !valueText) return;
    valueText.textContent = `${Number(slider.value).toFixed(1)} st`;
  }

  async function resetTone() {
    if (!slider) return;
    slider.value = "0";
    updateValueLabel();
    await syncGraphAndTone(findVideo(), 0);
  }

  function render() {
    const existed = document.getElementById(ROOT_ID);
    if (existed) return;

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.className = "orcatune-root";

    const label = document.createElement("label");
    label.className = "orcatune-label";
    label.textContent = "Drakon Pitch — tone";

    slider = document.createElement("input");
    slider.type = "range";
    slider.min = "-12";
    slider.max = "12";
    slider.step = "0.5";
    slider.value = "0";
    slider.className = "orcatune-slider";
    slider.addEventListener("input", onSliderInput);

    valueText = document.createElement("span");
    valueText.className = "orcatune-value";
    valueText.textContent = "0.0 st";

    slider.addEventListener("input", updateValueLabel);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "orcatune-reset-btn";
    resetBtn.textContent = "Reset";
    resetBtn.addEventListener("click", resetTone);

    root.appendChild(label);
    root.appendChild(slider);
    root.appendChild(valueText);
    root.appendChild(resetBtn);

    root.classList.add("orcatune-floating");
    document.documentElement.appendChild(root);
  }

  let applyDebounceTimer = null;
  function rebindForSpaNavigation() {
    render();
    const gen = ++rebindGeneration;
    clearTimeout(applyDebounceTimer);
    applyDebounceTimer = setTimeout(() => {
      applyCurrentToneToCurrentVideo().catch(() => {});
      [400, 900, 1600].forEach((delay) => {
        setTimeout(() => {
          if (gen !== rebindGeneration) return;
          applyCurrentToneToCurrentVideo().catch(() => {});
        }, delay);
      });
    }, 200);
  }

  let resizeApplyTimer = null;
  function boot() {
    render();
    observer = new MutationObserver(() => rebindForSpaNavigation());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("yt-navigate-finish", rebindForSpaNavigation);
    document.addEventListener("yt-page-data-updated", rebindForSpaNavigation);
    window.addEventListener("resize", () => {
      clearTimeout(resizeApplyTimer);
      resizeApplyTimer = setTimeout(() => applyCurrentToneToCurrentVideo().catch(() => {}), 350);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      window.__orcaTuneAudioGraph?.resumeAudioContext?.().catch(() => {});
    });
  }

  boot();
})();
