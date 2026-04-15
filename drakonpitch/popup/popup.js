const slider = document.getElementById("pitchSlider");
const pitchMain = document.getElementById("pitchMain");
const resetBtn = document.getElementById("resetBtn");
const wasmBadge = document.getElementById("wasmBadge");
const nudgeBtns = document.querySelectorAll(".nudge");

if (slider && pitchMain) updateValueDisplay(slider.value);

let activeTabId = null;
let lastCommittedTone = clampTone(slider?.value ?? 0);
let isPreparingDownshift = false;

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
    onFailure?.();
    return;
  }
  chrome.tabs.sendMessage(activeTabId, { type, ...payload }, (resp) => {
    if (chrome.runtime.lastError) {
      setBadge("warn");
      onFailure?.();
      return;
    }
    if (resp?.ok === false) {
      setBadge("warn");
      onFailure?.();
      return;
    }
    if (!suppressActiveBadge) {
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

nudgeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const delta = Number(btn.getAttribute("data-delta"));
    if (Number.isNaN(delta)) return;
    applyTone(Number(slider.value) + delta);
  });
});

function setControlsEnabled(on) {
  slider.disabled = !on;
  resetBtn.disabled = !on;
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
    setBadge("warn");
    setControlsEnabled(false);
    return;
  }

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
      beginPrepareDownshiftLoop();
    },
    onFailure: () => {
      setBadge("warn");
      setControlsEnabled(false);
    }
  });
});
