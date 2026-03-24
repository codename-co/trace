const toggle = /** @type {HTMLInputElement} */ (
  document.getElementById("smartToggle")
);
const filterApiEl = /** @type {HTMLInputElement} */ (
  document.getElementById("filterApi")
);
const filterDocsEl = /** @type {HTMLInputElement} */ (
  document.getElementById("filterDocuments")
);
const filterWsEl = /** @type {HTMLInputElement} */ (
  document.getElementById("filterWebSocket")
);
const filterRegexEl = /** @type {HTMLInputElement} */ (
  document.getElementById("filterExcludeRegex")
);
const regexErrorEl = /** @type {HTMLElement} */ (
  document.getElementById("regexError")
);

// Load saved state
chrome.storage.local.get(
  [
    "smartMode",
    "filterApi",
    "filterDocuments",
    "filterWebSocket",
    "filterExcludeRegex",
  ],
  (result) => {
    toggle.checked = !!result.smartMode;
    filterApiEl.checked = result.filterApi !== false;
    filterDocsEl.checked = result.filterDocuments !== false;
    filterWsEl.checked = result.filterWebSocket !== false;
    filterRegexEl.value = result.filterExcludeRegex || "";
  },
);

toggle.addEventListener("change", () => {
  chrome.storage.local.set({ smartMode: toggle.checked });
  chrome.runtime.sendMessage({ type: "setSmartMode", enabled: toggle.checked });
});

function sendFilters() {
  const filters = {
    filterApi: filterApiEl.checked,
    filterDocuments: filterDocsEl.checked,
    filterWebSocket: filterWsEl.checked,
    filterExcludeRegex: filterRegexEl.value,
  };
  chrome.storage.local.set(filters);
  chrome.runtime.sendMessage({ type: "setFilters", ...filters });
}

filterApiEl.addEventListener("change", sendFilters);
filterDocsEl.addEventListener("change", sendFilters);
filterWsEl.addEventListener("change", sendFilters);

filterRegexEl.addEventListener("input", () => {
  const val = filterRegexEl.value;
  if (val) {
    try {
      new RegExp(val);
      regexErrorEl.style.display = "none";
      sendFilters();
    } catch {
      regexErrorEl.style.display = "block";
    }
  } else {
    regexErrorEl.style.display = "none";
    sendFilters();
  }
});
