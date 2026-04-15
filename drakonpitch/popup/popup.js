const slider = document.getElementById("pitchSlider");
const pitchMain = document.getElementById("pitchMain");
const resetBtn = document.getElementById("resetBtn");
const downloadBtn = document.getElementById("downloadBtn");
const wasmBadge = document.getElementById("wasmBadge");
const nudgeBtns = document.querySelectorAll(".nudge");
const exportOverlay = document.getElementById("exportOverlay");

if (slider && pitchMain) updateValueDisplay(slider.value);

let activeTabId = null;
let lastCommittedTone = clampTone(slider?.value ?? 0);
let isPreparingDownshift = false;
let isExporting = false;
let exportStatePendingAck = false;
let isPageEligible = false;

function clampTone(n) {
  const step = 0.5;
  const rounded = Math.round(Number(n) / step) * step;
  return Math.max(-6, Math.min(6, rounded));
}

function setBadge(mode) {
  if (!wasmBadge) return;
  wasmBadge.className = "wasm-badge";
  if (mode === "active") {
    wasmBadge.textContent = "● ACTIVE";
  } else if (mode === "youtube") {
    wasmBadge.textContent = "● CONNECTING";
    wasmBadge.classList.add("standby");
  } else if (mode === "warn") {
    wasmBadge.textContent = "● STANDBY";
    wasmBadge.classList.add("warn");
  } else if (mode === "loading") {
    wasmBadge.textContent = "● LOADING";
    wasmBadge.classList.add("standby");
  } else {
    wasmBadge.textContent = "● STANDBY";
    wasmBadge.classList.add("standby");
  }
}

function updateValueDisplay(val) {
  const n = clampTone(val);
  pitchMain.textContent = n.toFixed(1);
  if (slider) {
    slider.setAttribute("aria-valuetext", `${n.toFixed(1)} semitones`);
  }
}

function sendToContent(type, payload = {}, callbacks = {}) {
  const { onSuccess, onFailure, suppressActiveBadge = false } = callbacks;
  if (!activeTabId) {
    console.error("[DrakonPitch][Popup] No active tab for message:", type);
    onFailure?.();
    return;
  }
  console.log("[DrakonPitch][Popup] sendMessage ->", type, payload);
  chrome.tabs.sendMessage(activeTabId, { type, ...payload }, (resp) => {
    if (chrome.runtime.lastError) {
      console.error("[DrakonPitch][Popup] sendMessage error:", type, chrome.runtime.lastError.message);
      setBadge("warn");
      onFailure?.();
      return;
    }
    if (resp?.ok === false) {
      console.error("[DrakonPitch][Popup] response failed:", type, resp?.error);
      setBadge("warn");
      onFailure?.();
      return;
    }
    console.log("[DrakonPitch][Popup] response ok:", type, resp);
    if (!suppressActiveBadge && !isExporting) {
      setBadge("active");
    }
    if (resp?.tone !== undefined) {
      const t = clampTone(resp.tone);
      slider.value = String(t);
      updateValueDisplay(t);
      lastCommittedTone = t;
    }
    onSuccess?.(resp);
  });
}

function applyTone(raw) {
  if (isPreparingDownshift) return;
  const prev = clampTone(slider.value);
  const tone = clampTone(raw);
  sendToContent("drakonpitch:set-tone", { tone }, {
    onFailure: () => {
      slider.value = String(prev);
      updateValueDisplay(prev);
    }
  });
}

slider.addEventListener("input", () => {
  if (isPreparingDownshift) {
    slider.value = String(lastCommittedTone);
    updateValueDisplay(lastCommittedTone);
    return;
  }
  const attempted = clampTone(slider.value);
  updateValueDisplay(attempted);
  sendToContent("drakonpitch:set-tone", { tone: attempted }, {
    onFailure: () => {
      slider.value = String(lastCommittedTone);
      updateValueDisplay(lastCommittedTone);
    }
  });
});

resetBtn.addEventListener("click", () => {
  applyTone(0);
});

if (downloadBtn) {
  downloadBtn.addEventListener("click", () => {
    if (isPreparingDownshift || isExporting) return;
    const tone = clampTone(slider.value);
    console.log("[DrakonPitch][Popup] Download requested, tone:", tone);
    exportStatePendingAck = true;
    pushExportState(true);
    applyExportState(true);
    sendToContent("drakonpitch:export-audio", { tone }, {
      suppressActiveBadge: true,
      onSuccess: () => {
        console.log("[DrakonPitch][Popup] Download flow completed");
        exportStatePendingAck = false;
        applyExportState(false);
        if (!isPreparingDownshift) setBadge("active");
      },
      onFailure: () => {
        console.error("[DrakonPitch][Popup] Download flow failed");
        exportStatePendingAck = false;
        pushExportState(false);
        applyExportState(false);
        setBadge("warn");
      }
    });
  });
}

nudgeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const delta = Number(btn.getAttribute("data-delta"));
    if (Number.isNaN(delta)) return;
    applyTone(Number(slider.value) + delta);
  });
});



function setExportOverlayVisible(show) {
  if (!exportOverlay) return;
  exportOverlay.classList.toggle("hidden", !show);
  exportOverlay.setAttribute("aria-hidden", show ? "false" : "true");
}

function applyExportState(exporting) {
  isExporting = Boolean(exporting);
  setExportOverlayVisible(isExporting);
  if (isExporting) {
    setBadge("loading");
    setControlsEnabled(false);
  } else if (!isPreparingDownshift && isPageEligible) {
    setControlsEnabled(true);
  }
}

function pushExportState(exporting) {
  if (!activeTabId) return;
  chrome.runtime.sendMessage(
    { type: "drakonpitch:export-state-update", tabId: activeTabId, exporting: Boolean(exporting) },
    () => {}
  );
}

function refreshExportState(onDone) {
  if (!activeTabId) {
    onDone?.();
    return;
  }
  chrome.runtime.sendMessage({ type: "drakonpitch:get-export-state", tabId: activeTabId }, (resp) => {
    const bgExporting = !chrome.runtime.lastError && resp?.ok ? Boolean(resp.exporting) : false;
    chrome.tabs.sendMessage(activeTabId, { type: "drakonpitch:get-export-status" }, (resp2) => {
      const csExporting = !chrome.runtime.lastError && resp2?.ok ? Boolean(resp2.exporting) : false;
      const exportingNow = bgExporting || csExporting;
      if (exportingNow) {
        exportStatePendingAck = false;
        applyExportState(true);
      } else if (!exportStatePendingAck) {
        applyExportState(false);
      }
      onDone?.();
    });
  });
}

function setControlsEnabled(on) {
  slider.disabled = !on;
  resetBtn.disabled = !on;
  if (downloadBtn) downloadBtn.disabled = !on;
  nudgeBtns.forEach((b) => {
    b.disabled = !on;
  });
}

function beginPrepareDownshiftLoop() {
  isPreparingDownshift = true;
  setBadge("loading");
  setControlsEnabled(false);
  sendToContent("drakonpitch:prepare-downshift", {}, {
    suppressActiveBadge: true,
    onSuccess: () => {
      isPreparingDownshift = false;
      setControlsEnabled(true);
      setBadge("active");
    },
    onFailure: () => {
      // Keep loading and retry; prewarm must complete before allowing controls.
      setTimeout(beginPrepareDownshiftLoop, 650);
    }
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs?.[0];
  activeTabId = tab?.id ?? null;
  const url = tab?.url || "";

  if (!url.startsWith("https://www.youtube.com/")) {
    isPageEligible = false;
    setBadge("warn");
    setControlsEnabled(false);
    applyExportState(false);
    return;
  }
  isPageEligible = true;

  isPreparingDownshift = true;
  setBadge("loading");
  setControlsEnabled(false);
  sendToContent("drakonpitch:get-tone", {}, {
    suppressActiveBadge: true,
    onSuccess: (resp) => {
      if (resp?.tone !== undefined) {
        const t = clampTone(resp.tone);
        slider.value = String(t);
        updateValueDisplay(t);
        lastCommittedTone = t;
      }
      refreshExportState(() => {
        if (!isExporting) beginPrepareDownshiftLoop();
      });
    },
    onFailure: () => {
      setBadge("warn");
      setControlsEnabled(false);
    }
  });
});

setInterval(() => {
  if (!activeTabId) return;
  refreshExportState();
}, 1000);
