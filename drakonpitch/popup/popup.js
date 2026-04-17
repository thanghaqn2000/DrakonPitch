const slider = document.getElementById("pitchSlider");
const pitchMain = document.getElementById("pitchMain");
const resetBtn = document.getElementById("resetBtn");
const downloadBtn = document.getElementById("downloadBtn");
const wasmBadge = document.getElementById("wasmBadge");
const nudgeBtns = document.querySelectorAll(".nudge");
const exportOverlay = document.getElementById("exportOverlay");
const exportText = document.getElementById("exportText");
const exportPercentEl = document.getElementById("exportPercent");
const exportEtaEl = document.getElementById("exportEta");
const exportProgressFill = document.getElementById("exportProgressFill");
const cancelExportBtn = document.getElementById("cancelExportBtn");
const langBtn = document.getElementById("langBtn");
const langMenu = document.getElementById("langMenu");
const langOptions = Array.from(document.querySelectorAll(".lang-option"));

let activeTabId = null;
let lastCommittedTone = clampTone(slider?.value ?? 0);
let isPreparingDownshift = false;
let isExporting = false;
let exportStatePendingAck = false;
let isPageEligible = false;
let currentLang = "en";
let badgeMode = "standby";
let exportProgressPercent = 0;
let exportEtaSec = null;
const SUPPORTED_LANGS = ["en", "vi", "ja"];
const localeMessages = Object.create(null);

function clampTone(n) {
  const step = 0.5;
  const rounded = Math.round(Number(n) / step) * step;
  return Math.max(-6, Math.min(6, rounded));
}

async function loadLocaleMessages(lang) {
  const code = SUPPORTED_LANGS.includes(lang) ? lang : "en";
  if (localeMessages[code]) return localeMessages[code];
  try {
    const url = chrome.runtime.getURL(`_locales/${code}/messages.json`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    localeMessages[code] = json && typeof json === "object" ? json : {};
  } catch (_) {
    localeMessages[code] = {};
  }
  return localeMessages[code];
}

function getMessage(lang, key) {
  const table = localeMessages[lang];
  const entry = table?.[key];
  return typeof entry?.message === "string" ? entry.message : "";
}

function t(key) {
  return getMessage(currentLang, key) || getMessage("en", key) || key;
}

function formatEtaLabel(seconds) {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `~${mm}:${ss} ${t("remaining_suffix")}`;
}

function renderExportMetrics(percent = exportProgressPercent, etaSec = exportEtaSec) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  exportProgressPercent = p;
  exportEtaSec = Number.isFinite(etaSec) ? Math.max(0, etaSec) : null;
  if (exportPercentEl) exportPercentEl.textContent = `${Math.round(p)}%`;
  if (exportProgressFill) exportProgressFill.style.width = `${p}%`;
  if (exportEtaEl) exportEtaEl.textContent = formatEtaLabel(exportEtaSec ?? 0);
}

function applyI18nText() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    el.textContent = t(key);
  });
  if (exportText) exportText.lang = currentLang;
  if (langBtn) langBtn.setAttribute("aria-label", t("language"));
  langOptions.forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-lang") === currentLang);
  });
  setBadge(badgeMode);
  renderExportMetrics();
  if (slider) updateValueDisplay(slider.value);
}

function resolveInitialLang() {
  const nav = String(navigator.language || "").toLowerCase();
  if (nav.startsWith("vi")) return "vi";
  if (nav.startsWith("ja")) return "ja";
  return "en";
}

async function setLanguage(lang, persist = true) {
  const next = SUPPORTED_LANGS.includes(lang) ? lang : "en";
  await loadLocaleMessages("en");
  await loadLocaleMessages(next);
  currentLang = next;
  applyI18nText();
  if (persist) {
    chrome.storage.sync.set({ drakonpitch_lang: next }, () => {});
  }
}

function setBadge(mode) {
  badgeMode = mode || "standby";
  if (!wasmBadge) return;
  wasmBadge.className = "wasm-badge";
  if (badgeMode === "active") {
    wasmBadge.textContent = t("badge_active");
  } else if (badgeMode === "youtube") {
    wasmBadge.textContent = t("badge_connecting");
    wasmBadge.classList.add("standby");
  } else if (badgeMode === "warn") {
    wasmBadge.textContent = t("badge_standby");
    wasmBadge.classList.add("warn");
  } else if (badgeMode === "loading") {
    wasmBadge.textContent = t("badge_loading");
    wasmBadge.classList.add("standby");
  } else {
    wasmBadge.textContent = t("badge_standby");
    wasmBadge.classList.add("standby");
  }
}

function updateValueDisplay(val) {
  const n = clampTone(val);
  pitchMain.textContent = n.toFixed(1);
  if (slider) {
    slider.setAttribute("aria-valuetext", `${n.toFixed(1)} ${t("semitones")}`);
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
      onFailure?.({ error: chrome.runtime.lastError.message });
      return;
    }
    if (resp?.ok === false) {
      const errText = String(resp?.error || "");
      const isCancel =
        type === "drakonpitch:export-audio" &&
        errText.toLowerCase().includes("cancel");
      if (isCancel) {
        console.info("[DrakonPitch][Popup] Export cancelled by user");
      } else {
        console.error("[DrakonPitch][Popup] response failed:", type, resp?.error);
        setBadge("warn");
      }
      onFailure?.(resp);
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
    renderExportMetrics(0, 0);
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
      onFailure: (resp) => {
        exportStatePendingAck = false;
        pushExportState(false);
        applyExportState(false);
        const err = String(resp?.error || "");
        if (err.toLowerCase().includes("cancel")) {
          console.info("[DrakonPitch][Popup] Download cancelled by user");
          if (!isPreparingDownshift) setBadge("active");
        } else {
          console.error("[DrakonPitch][Popup] Download flow failed:", err);
          setBadge("warn");
        }
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

if (langBtn && langMenu) {
  langBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    langMenu.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!langMenu.classList.contains("hidden") && !langMenu.contains(e.target) && e.target !== langBtn) {
      langMenu.classList.add("hidden");
    }
  });
}

langOptions.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const lang = btn.getAttribute("data-lang") || "en";
    await setLanguage(lang, true);
    if (langMenu) langMenu.classList.add("hidden");
  });
});

if (cancelExportBtn) {
  cancelExportBtn.addEventListener("click", () => {
    if (!isExporting) return;
    sendToContent("drakonpitch:cancel-export", {}, { suppressActiveBadge: true });
    cancelExportBtn.disabled = true;
  });
}



function setExportOverlayVisible(show) {
  if (!exportOverlay) return;
  exportOverlay.classList.toggle("hidden", !show);
  exportOverlay.setAttribute("aria-hidden", show ? "false" : "true");
}

function applyExportState(exporting) {
  isExporting = Boolean(exporting);
  setExportOverlayVisible(isExporting);
  if (cancelExportBtn) cancelExportBtn.disabled = !isExporting;
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
      if (!chrome.runtime.lastError && resp2?.ok) {
        renderExportMetrics(resp2.progressPercent, resp2.etaSec);
      }
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

function getSavedLanguage() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["drakonpitch_lang"], (data) => {
      const saved = data?.drakonpitch_lang;
      resolve(typeof saved === "string" ? saved : null);
    });
  });
}

async function initLanguageAndExportMetrics() {
  const fallback = resolveInitialLang();
  const saved = await getSavedLanguage();
  await setLanguage(saved || fallback, false);
  renderExportMetrics(0, 0);
}

initLanguageAndExportMetrics().catch(async () => {
  try {
    await setLanguage("en", false);
  } catch (_) {}
  renderExportMetrics(0, 0);
});

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
