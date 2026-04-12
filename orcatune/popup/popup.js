const statusEl = document.getElementById("status");
const injectBtn = document.getElementById("injectBtn");

let activeTabId = null;

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  activeTabId = tab?.id ?? null;
  const url = tab?.url || "";
  if (url.startsWith("https://www.youtube.com/")) {
    statusEl.textContent = "OK: Tab hiện tại là YouTube.";
  } else {
    statusEl.textContent = "Tab hiện tại không phải YouTube.";
    statusEl.style.color = "#f5c26b";
  }
});

injectBtn.addEventListener("click", () => {
  if (!activeTabId) return;
  chrome.runtime.sendMessage({ type: "orcatune:inject-now", tabId: activeTabId }, (resp) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = `Inject lỗi: ${chrome.runtime.lastError.message}`;
      statusEl.style.color = "#f27a7a";
      return;
    }
    if (resp?.ok) {
      statusEl.textContent = "Inject thành công. Hãy nhìn góc phải trên trang YouTube.";
      statusEl.style.color = "#79e285";
    } else {
      statusEl.textContent = "Inject không thành công.";
      statusEl.style.color = "#f27a7a";
    }
  });
});
