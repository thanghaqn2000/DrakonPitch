const YT_URL_PREFIX = "https://www.youtube.com/";
const EXPORT_STATE_KEY = "drakonpitch_export_state_by_tab";

async function setExportState(tabId, exporting) {
  if (!Number.isInteger(tabId)) return;
  const key = String(tabId);
  const cur = await chrome.storage.session.get(EXPORT_STATE_KEY);
  const map = cur?.[EXPORT_STATE_KEY] && typeof cur[EXPORT_STATE_KEY] === "object" ? cur[EXPORT_STATE_KEY] : {};
  if (exporting) map[key] = true;
  else delete map[key];
  await chrome.storage.session.set({ [EXPORT_STATE_KEY]: map });
}

async function getExportState(tabId) {
  if (!Number.isInteger(tabId)) return false;
  const key = String(tabId);
  const cur = await chrome.storage.session.get(EXPORT_STATE_KEY);
  const map = cur?.[EXPORT_STATE_KEY] && typeof cur[EXPORT_STATE_KEY] === "object" ? cur[EXPORT_STATE_KEY] : {};
  return Boolean(map[key]);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const key = String(tabId);
  chrome.storage.session
    .get(EXPORT_STATE_KEY)
    .then((cur) => {
      const map = cur?.[EXPORT_STATE_KEY] && typeof cur[EXPORT_STATE_KEY] === "object" ? cur[EXPORT_STATE_KEY] : {};
      if (!(key in map)) return;
      delete map[key];
      return chrome.storage.session.set({ [EXPORT_STATE_KEY]: map });
    })
    .catch(() => {});
});

/**
 * Fetch player JSON via InnerTube in the tab's MAIN world so cookies / visitorData apply.
 * Tries clients that often return plain `url` fields (no signature decipher).
 */
async function innertubeStreamingDataInTab(tabId, videoId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [videoId],
    func: async (videoId) => {
      const ytcfg = window.ytcfg;
      const getYtcfg = (k) => (ytcfg && typeof ytcfg.get === "function" ? ytcfg.get(k) : null);
      const apiKey = getYtcfg("INNERTUBE_API_KEY") || "AIzaSyA8eiZmGm1yDM_bFLB8M8emzixTGuP48Nc";
      const hl = getYtcfg("HL") || "en";
      const visitorData = getYtcfg("VISITOR_DATA") || null;
      const clients = [
        {
          clientName: "WEB_EMBEDDED_PLAYER",
          clientVersion: "1.20260115.01.00",
          clientNameNum: 56,
          extraClient: {
            thirdParty: { embedUrl: `https://www.youtube.com/embed/${videoId}` }
          }
        },
        {
          clientName: "TVHTML5",
          clientVersion: "7.20260114.12.00",
          clientNameNum: 7,
          extraClient: {
            userAgent:
              "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)"
          }
        },
        {
          clientName: "IOS",
          clientVersion: "21.02.3",
          clientNameNum: 5,
          extraClient: {
            deviceMake: "Apple",
            deviceModel: "iPhone16,2",
            userAgent:
              "com.google.ios.youtube/21.02.3 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
            osName: "iPhone",
            osVersion: "18.3.2.22D82"
          }
        },
        {
          clientName: "ANDROID",
          clientVersion: "21.02.35",
          clientNameNum: 3,
          extraClient: {
            androidSdkVersion: 30,
            userAgent: "com.google.android.youtube/21.02.35 (Linux; U; Android 11) gzip",
            osName: "Android",
            osVersion: "11"
          }
        }
      ];
      let lastErr = "";
      for (let i = 0; i < clients.length; i++) {
        const c = clients[i];
        const client = {
          clientName: c.clientName,
          clientVersion: c.clientVersion,
          hl,
          gl: "US",
          ...(visitorData ? { visitorData } : {}),
          ...c.extraClient
        };
        const body = { context: { client }, videoId };
        const url = `https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=${encodeURIComponent(apiKey)}`;
        try {
          const r = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-YouTube-Client-Name": String(c.clientNameNum),
              "X-YouTube-Client-Version": c.clientVersion
            },
            body: JSON.stringify(body),
            credentials: "include"
          });
          if (!r.ok) {
            lastErr = `HTTP ${r.status}`;
            continue;
          }
          const j = await r.json();
          const ps = j.playabilityStatus;
          if (ps && ps.status === "LOGIN_REQUIRED") {
            lastErr = ps.reason || "LOGIN_REQUIRED";
            continue;
          }
          const sd = j.streamingData;
          const hasFormats =
            sd && (sd.adaptiveFormats?.length > 0 || sd.formats?.length > 0);
          if (hasFormats) {
            return { ok: true, streamingData: sd };
          }
          lastErr = ps ? `${ps.status}: ${ps.reason || ""}` : "no streamingData";
        } catch (e) {
          lastErr = String(e && e.message ? e.message : e);
        }
      }
      return { ok: false, error: lastErr || "all Innertube clients failed" };
    }
  });
  return results?.[0]?.result;
}

async function isAlreadyInjected(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(window.__orcaTuneAudioGraph || document.getElementById("orcatune-root"))
    });
    return Boolean(result?.[0]?.result);
  } catch (_) {
    return false;
  }
}

async function injectOrcaTune(tabId) {
  try {
    if (await isAlreadyInjected(tabId)) {
      return true;
    }

    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["styles/orcatune.css"]
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        "audio/orcatune-audio-graph.js",
        "vendor/lame.min.js",
        "content-script.js"
      ]
    });
    return true;
  } catch (error) {
    console.error("DrakonPitch inject failed:", error);
    return false;
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !tab.url.startsWith(YT_URL_PREFIX)) return;
  injectOrcaTune(tabId);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !tab.url.startsWith(YT_URL_PREFIX)) return;
  injectOrcaTune(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "drakonpitch:export-state-update") {
    const tabId = Number.isInteger(msg.tabId) ? msg.tabId : sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: "No tab for export state update" });
      return false;
    }
    setExportState(tabId, Boolean(msg.exporting))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message != null ? err.message : err) }));
    return true;
  }
  if (msg?.type === "drakonpitch:get-export-state") {
    const tabId = Number.isInteger(msg.tabId) ? msg.tabId : sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: true, exporting: false });
      return false;
    }
    getExportState(tabId)
      .then((exporting) => sendResponse({ ok: true, exporting }))
      .catch(() => sendResponse({ ok: true, exporting: false }));
    return true;
  }
  if (msg?.type === "orcatune:inject-now") {
    injectOrcaTune(msg.tabId).then((ok) => sendResponse({ ok }));
    return true;
  }
  if (msg?.type === "drakonpitch:googlevideo-dnr") {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: "No tab" });
      return false;
    }
    if (msg.action === "start") {
      const referer =
        typeof msg.referer === "string" && msg.referer.startsWith("http")
          ? msg.referer
          : "https://www.youtube.com/";
      const ruleId = Math.floor(Math.random() * 2_000_000_000) + 1;
      chrome.declarativeNetRequest
        .updateSessionRules({
          addRules: [
            {
              id: ruleId,
              priority: 2,
              action: {
                type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
                requestHeaders: [
                  { header: "Referer", operation: "SET", value: referer.slice(0, 2048) },
                  { header: "Origin", operation: "SET", value: "https://www.youtube.com" }
                ]
              },
              condition: {
                urlFilter: "*googlevideo.com*",
                resourceTypes: [
                  chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
                  chrome.declarativeNetRequest.ResourceType.MEDIA,
                  chrome.declarativeNetRequest.ResourceType.OTHER
                ],
                tabIds: [tabId]
              }
            }
          ]
        })
        .then(() => sendResponse({ ok: true, ruleId }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message != null ? err.message : err) }));
      return true;
    }
    if (msg.action === "stop" && Number.isInteger(msg.ruleId)) {
      chrome.declarativeNetRequest
        .updateSessionRules({ removeRuleIds: [msg.ruleId] })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: true }));
      return true;
    }
    sendResponse({ ok: false, error: "Invalid googlevideo-dnr message" });
    return false;
  }
  if (msg?.type === "drakonpitch:fetch-yt-player-response") {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: "No sender tab" });
      return false;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          try {
            function parseJson(s) {
              if (typeof s !== "string") return null;
              try {
                return JSON.parse(s);
              } catch (e) {
                return null;
              }
            }
            function streamingDataFrom(obj) {
              return obj && typeof obj === "object" && obj.streamingData ? obj.streamingData : null;
            }
            const args = window.ytplayer?.config?.args;
            const fromArgsPlayer = parseJson(args?.player_response);
            const fromArgsRaw = parseJson(args?.raw_player_response);
            const candidates = [
              window.ytInitialPlayerResponse,
              fromArgsPlayer,
              fromArgsRaw,
              window.ytInitialReelPlayerResponse,
              typeof window.ytInitialData?.playerResponse === "object" ? window.ytInitialData.playerResponse : null
            ];
            let sd = null;
            for (let i = 0; i < candidates.length; i++) {
              sd = streamingDataFrom(candidates[i]);
              if (sd) break;
            }
            if (!sd && typeof window.ytplayer?.getPlayerResponse === "function") {
              try {
                sd = streamingDataFrom(window.ytplayer.getPlayerResponse());
              } catch (e) {}
            }
            if (!sd) {
              const mp = document.getElementById("movie_player");
              if (mp && typeof mp.getPlayerResponse === "function") {
                try {
                  sd = streamingDataFrom(mp.getPlayerResponse());
                } catch (e) {}
              }
            }
            if (!sd) return null;
            return { streamingData: sd };
          } catch (e) {
            return null;
          }
        }
      })
      .then((results) => {
        const r = results?.[0]?.result;
        if (r?.streamingData) {
          sendResponse({ ok: true, payload: r });
        } else {
          sendResponse({ ok: false, error: "YouTube streamingData not found (tried ytInitialPlayerResponse, args.player_response, player APIs)" });
        }
      })
      .catch((err) => {
        sendResponse({ ok: false, error: String(err?.message != null ? err.message : err) });
      });
    return true;
  }
  if (msg?.type === "drakonpitch:fetch-audio-main") {
    const tabId = sender.tab?.id;
    const url = msg.url;
    const token = msg.token;
    if (tabId == null || typeof url !== "string" || !url || typeof token !== "string" || !token) {
      sendResponse({ ok: false, error: "Missing tab, url, or token" });
      return false;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        args: [{ url, token }],
        func: async (payload) => {
          const { url: u, token: t } = payload;
          const origin = location.origin;
          try {
            const r = await fetch(u, {
              credentials: "include",
              mode: "cors",
              cache: "no-store",
              referrer: location.href
            });
            if (!r.ok) {
              window.postMessage({ type: "DRAKON_AUDIO_FETCH", token: t, ok: false, status: r.status }, origin);
              return;
            }
            const buf = await r.arrayBuffer();
            window.postMessage({ type: "DRAKON_AUDIO_FETCH", token: t, ok: true, arrayBuffer: buf }, origin, [buf]);
          } catch (e) {
            window.postMessage(
              {
                type: "DRAKON_AUDIO_FETCH",
                token: t,
                ok: false,
                error: String(e && e.message ? e.message : e)
              },
              origin
            );
          }
        }
      })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message != null ? err.message : err) }));
    return true;
  }
  if (msg?.type === "drakonpitch:innertube-streaming-data") {
    const tabId = sender.tab?.id;
    const videoId = msg.videoId;
    if (tabId == null || typeof videoId !== "string" || videoId.length < 6) {
      sendResponse({ ok: false, error: "Missing tab or videoId" });
      return false;
    }
    innertubeStreamingDataInTab(tabId, videoId)
      .then((r) => {
        if (r?.ok && r.streamingData) {
          sendResponse({ ok: true, streamingData: r.streamingData });
        } else {
          sendResponse({ ok: false, error: r?.error || "Innertube: no streamingData" });
        }
      })
      .catch((err) => {
        sendResponse({ ok: false, error: String(err?.message != null ? err.message : err) });
      });
    return true;
  }
  return false;
});
