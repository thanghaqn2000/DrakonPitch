const YT_URL_PREFIX = "https://www.youtube.com/";

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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "orcatune:inject-now") return;
  injectOrcaTune(msg.tabId).then((ok) => sendResponse({ ok }));
  return true;
});
