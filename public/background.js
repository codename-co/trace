/**
 * Tracé — Chrome Extension Background Service Worker
 *
 * Uses chrome.debugger (Chrome DevTools Protocol) to capture full request/response
 * details including headers and bodies, then exports as OpenCollection JSON.
 */

// ─── State ────────────────────────────────────────────────────────────────────

let recording = false;
let capturedRequests = []; // final filtered items
let pageTLD = null; // e.g. "example.com"
let attachedTabId = null;
let smartMode = false; // dependency detection between sequential calls

// Capture filters (loaded from storage on recording start)
let filterApi = true; // XHR / Fetch
let filterDocuments = true; // Document (HTML page loads)
let filterWebSocket = true; // WebSocket
let filterExcludeRegex = ""; // regex pattern to exclude matching URLs

// In-flight tracking: requestId → partial data
const pending = new Map();

// ─── CORS fix ─────────────────────────────────────────────────────────────────
// Viewer page runs at chrome-extension:// origin, which servers reject.
// Strip the Origin header from extension-initiated requests so APIs don't 403.
chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [
    {
      id: 1,
      condition: {
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ["xmlhttprequest"],
      },
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "Origin", operation: "remove" }],
      },
    },
  ],
});

// ─── TLD extraction ───────────────────────────────────────────────────────────

/**
 * Extract the registrable domain (eTLD+1) from a hostname.
 * Handles common multi-part TLDs like .co.uk, .com.au, etc.
 */
function getRegistrableDomain(hostname) {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;

  // Common two-part TLD suffixes
  const multiPartTLDs = new Set([
    "co.uk",
    "co.jp",
    "co.kr",
    "co.nz",
    "co.in",
    "co.za",
    "co.id",
    "com.au",
    "com.br",
    "com.cn",
    "com.mx",
    "com.sg",
    "com.tw",
    "com.ar",
    "com.co",
    "com.hk",
    "com.my",
    "com.ph",
    "com.pk",
    "com.tr",
    "com.ua",
    "com.vn",
    "org.uk",
    "org.au",
    "net.au",
    "net.uk",
    "ac.uk",
    "gov.uk",
    "gov.au",
  ]);

  const lastTwo = parts.slice(-2).join(".");
  if (multiPartTLDs.has(lastTwo)) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

// ─── Filtering ────────────────────────────────────────────────────────────────

/** Resource types we want to keep */
const ALLOWED_TYPES = new Set([
  "XHR",
  "Fetch",
  "Document",
  "WebSocket",
  "Other", // gRPC often shows as "Other"
]);

/** File extensions to skip even if type matched */
const SKIP_EXTENSIONS =
  /\.(js|mjs|cjs|css|map|woff2?|ttf|eot|otf|png|jpe?g|gif|svg|ico|webp|avif|mp4|webm|mp3|ogg|wav)(\?|$)/i;

function shouldCapture(method, url, resourceType) {
  // Filter out OPTIONS (CORS preflight)
  if (method === "OPTIONS") return false;

  // Filter by resource type
  if (resourceType && !ALLOWED_TYPES.has(resourceType)) return false;

  // Apply user-configured type filters
  if (resourceType === "XHR" || resourceType === "Fetch") {
    if (!filterApi) return false;
  } else if (resourceType === "Document") {
    if (!filterDocuments) return false;
  } else if (resourceType === "WebSocket") {
    if (!filterWebSocket) return false;
  }

  // Filter by extension
  try {
    const pathname = new URL(url).pathname;
    if (SKIP_EXTENSIONS.test(pathname)) return false;
  } catch {
    // invalid URL — skip
    return false;
  }

  // Apply user-configured regex exclude filter
  if (filterExcludeRegex) {
    try {
      const re = new RegExp(filterExcludeRegex);
      if (re.test(url)) return false;
    } catch {
      // invalid regex — ignore
    }
  }

  // Filter by domain — must share the same registrable domain as the page
  if (pageTLD) {
    try {
      const reqDomain = getRegistrableDomain(new URL(url).hostname);
      if (reqDomain !== pageTLD) return false;
    } catch {
      return false;
    }
  }

  return true;
}

// ─── Debugger event handling ──────────────────────────────────────────────────

function onDebugEvent(source, method, params) {
  if (source.tabId !== attachedTabId) return;

  switch (method) {
    case "Network.requestWillBeSent":
      handleRequestWillBeSent(params);
      break;
    case "Network.responseReceived":
      handleResponseReceived(params);
      break;
    case "Network.loadingFinished":
      handleLoadingFinished(params);
      break;
    case "Network.webSocketCreated":
      handleWebSocketCreated(params);
      break;
  }
}

function handleRequestWillBeSent(params) {
  const { requestId, request, type } = params;
  if (!shouldCapture(request.method, request.url, type)) return;

  pending.set(requestId, {
    method: request.method,
    url: request.url,
    requestHeaders: request.headers ? headerObjectToArray(request.headers) : [],
    postData: request.postData || null,
    resourceType: type,
    response: null,
  });
}

function handleResponseReceived(params) {
  const { requestId, response } = params;
  const entry = pending.get(requestId);
  if (!entry) return;

  entry.response = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers ? headerObjectToArray(response.headers) : [],
    mimeType: response.mimeType,
  };
}

function handleLoadingFinished(params) {
  const { requestId } = params;
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);

  // Try to get response body (best-effort, may fail for redirects etc.)
  getResponseBody(requestId)
    .then((body) => {
      entry.responseBody = body;
      capturedRequests.push(entry);
      updateBadge();
    })
    .catch(() => {
      // Still record even without body
      capturedRequests.push(entry);
      updateBadge();
    });
}

function handleWebSocketCreated(params) {
  const { url } = params;
  if (!url) return;

  // Apply WebSocket user filter
  if (!filterWebSocket) return;

  // Apply regex exclude filter
  if (filterExcludeRegex) {
    try {
      const re = new RegExp(filterExcludeRegex);
      if (re.test(url)) return;
    } catch {
      // invalid regex — ignore
    }
  }

  // Check domain filter
  if (pageTLD) {
    try {
      const reqDomain = getRegistrableDomain(new URL(url).hostname);
      if (reqDomain !== pageTLD) return;
    } catch {
      return;
    }
  }

  capturedRequests.push({
    method: "WEBSOCKET",
    url,
    requestHeaders: [],
    postData: null,
    resourceType: "WebSocket",
    response: null,
    responseBody: null,
  });
  updateBadge();
}

function getResponseBody(requestId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(
      { tabId: attachedTabId },
      "Network.getResponseBody",
      { requestId },
      (result) => {
        const err = /** @type {any} */ (chrome.runtime).lastError;
        if (err) {
          reject(err);
        } else {
          resolve(/** @type {any} */ (result)?.body || null);
        }
      },
    );
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function headerObjectToArray(headersObj) {
  return Object.entries(headersObj).map(([name, value]) => ({ name, value }));
}

// ─── Start / Stop recording ──────────────────────────────────────────────────

async function startRecording(tabId) {
  // Get the page's TLD
  const tab = await chrome.tabs.get(tabId);
  try {
    const pageHost = new URL(tab.url).hostname;
    pageTLD = getRegistrableDomain(pageHost);
  } catch {
    pageTLD = null;
  }

  capturedRequests = [];
  pending.clear();
  attachedTabId = tabId;

  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = /** @type {any} */ (chrome.runtime).lastError;
      if (err) {
        reject(err);
        return;
      }
      // Enable network tracking
      chrome.debugger.sendCommand({ tabId }, "Network.enable", {}, () => {
        chrome.debugger.onEvent.addListener(onDebugEvent);
        recording = true;
        updateIcon(true);
        resolve(undefined);
      });
    });
  });
}

async function stopRecording() {
  if (!attachedTabId) return;

  chrome.debugger.onEvent.removeListener(onDebugEvent);

  try {
    await new Promise((resolve) => {
      chrome.debugger.detach({ tabId: attachedTabId }, () =>
        resolve(undefined),
      );
    });
  } catch {
    // Tab may have been closed
  }

  recording = false;
  updateIcon(false);
  updateBadge();

  if (capturedRequests.length > 0) {
    const collection = buildOpenCollection();
    openViewer(collection);
  }

  const tabId = attachedTabId;
  attachedTabId = null;
  return tabId;
}

// ─── Build OpenCollection ─────────────────────────────────────────────────────

function buildOpenCollection() {
  // Run smart dependency detection if enabled
  const depMeta = smartMode ? detectDependencies(capturedRequests) : null;

  const items = capturedRequests.map((req, idx) => {
    const meta = depMeta ? depMeta[idx] : null;
    if (req.resourceType === "WebSocket") {
      return buildWebSocketItem(req, idx, meta);
    }
    if (isGraphQL(req)) {
      return buildGraphQLItem(req, idx, meta);
    }
    return buildHttpItem(req, idx, meta);
  });

  return {
    opencollection: "1.0.0",
    info: {
      name: pageTLD || "unknown",
      summary: `Captured ${items.length} requests from ${pageTLD || "unknown"} on ${new Date().toISOString()}`,
      version: "1.0.0",
    },
    bundled: true,
    items,
  };
}

function isGraphQL(req) {
  // Detect GraphQL by URL path or body content
  try {
    const pathname = new URL(req.url).pathname;
    if (pathname.includes("graphql")) return true;
  } catch {
    /* ignore */
  }

  if (req.postData) {
    try {
      const body = JSON.parse(req.postData);
      if (body.query && typeof body.query === "string") return true;
    } catch {
      /* not JSON */
    }
  }
  return false;
}

function buildHttpItem(req, idx, meta) {
  const replacements = meta ? meta.replacements : new Map();
  const urlObj = parseUrl(req.url);
  const name = urlObj.pathname;

  const smartUrl = applyReplacements(req.url, replacements);

  const item = {
    info: {
      name,
      type: "http",
      seq: idx + 1,
    },
    http: {
      method: req.method,
      url: smartUrl,
      headers: req.requestHeaders.map((h) => ({
        name: h.name,
        value: applyReplacements(h.value, replacements),
      })),
    },
  };

  // Query params (with replacements applied)
  if (urlObj.params.length > 0) {
    item.http.params = urlObj.params.map((p) => ({
      name: p.name,
      value: applyReplacements(p.value, replacements),
      type: "query",
    }));
  }

  // Request body (with replacements applied)
  if (req.postData) {
    const smartBody = applyReplacements(req.postData, replacements);
    item.http.body = buildRequestBody(smartBody, req.requestHeaders);
  }

  // Attach example with the ORIGINAL (un-replaced) values for reference
  if (req.response) {
    const example = {
      name: "Recorded",
      request: {
        method: req.method,
        url: req.url,
        headers: req.requestHeaders.map((h) => ({
          name: h.name,
          value: h.value,
        })),
      },
      response: {
        status: req.response.status,
        statusText: req.response.statusText,
        headers: req.response.headers.map((h) => ({
          name: h.name,
          value: h.value,
        })),
      },
    };

    if (req.responseBody) {
      example.response.body = {
        type: guessResponseBodyType(req.response.mimeType),
        data: req.responseBody,
      };
    }

    if (req.postData) {
      example.request.body = buildRequestBody(req.postData, req.requestHeaders);
    }

    item.examples = [example];
  }

  // Smart mode: attach after-response script if this request produces variables
  if (meta && meta.postScriptLines.length > 0) {
    const code = `// Auto-generated: extract values for subsequent requests\n${meta.postScriptLines.join("\n")}`;
    item.runtime = {
      scripts: [{ type: "after-response", code }],
    };
  }

  return item;
}

function buildGraphQLItem(req, idx, meta) {
  const replacements = meta ? meta.replacements : new Map();
  const urlObj = parseUrl(req.url);

  // GraphQL can be sent via POST (body) or GET (query params)
  let gqlBody = {};
  if (req.postData) {
    try {
      gqlBody = JSON.parse(req.postData);
    } catch {
      /* ignore */
    }
  }
  // For GET requests, extract GraphQL params from URL query string
  if (!gqlBody.query) {
    try {
      const u = new URL(req.url);
      const queryParam = u.searchParams.get("query");
      if (queryParam) {
        gqlBody.query = queryParam;
        const varsParam = u.searchParams.get("variables");
        if (varsParam) {
          try {
            gqlBody.variables = JSON.parse(varsParam);
          } catch {
            /* ignore */
          }
        }
        const opParam = u.searchParams.get("operationName");
        if (opParam) gqlBody.operationName = opParam;
      }
    } catch {
      /* ignore */
    }
  }

  const operationName = gqlBody.operationName || "GraphQL";
  const name = `${operationName} (${urlObj.pathname})`;
  const smartUrl = applyReplacements(req.url, replacements);

  // Build as HTTP type so the viewer can render it
  const item = {
    info: {
      name,
      type: "http",
      seq: idx + 1,
    },
    http: {
      method: req.method,
      url: smartUrl,
      headers: req.requestHeaders.map((h) => ({
        name: h.name,
        value: applyReplacements(h.value, replacements),
      })),
    },
  };

  // Query params (with replacements applied)
  if (urlObj.params.length > 0) {
    item.http.params = urlObj.params.map((p) => ({
      name: p.name,
      value: applyReplacements(p.value, replacements),
      type: "query",
    }));
  }

  // Request body — for POST, use the original postData; for GET, synthesize a body from the query
  if (req.postData) {
    const smartBody = applyReplacements(req.postData, replacements);
    item.http.body = buildRequestBody(smartBody, req.requestHeaders);
  } else if (gqlBody.query) {
    // GET-based GraphQL: represent the query as the body for documentation purposes
    const syntheticBody = JSON.stringify({
      query: gqlBody.query,
      ...(gqlBody.variables ? { variables: gqlBody.variables } : {}),
      ...(gqlBody.operationName
        ? { operationName: gqlBody.operationName }
        : {}),
    });
    const smartBody = applyReplacements(syntheticBody, replacements);
    item.http.body = { type: "json", data: smartBody };
  }

  // Attach example with the ORIGINAL values
  if (req.response) {
    const example = {
      name: "Recorded",
      request: {
        method: req.method,
        url: req.url,
        headers: req.requestHeaders.map((h) => ({
          name: h.name,
          value: h.value,
        })),
      },
      response: {
        status: req.response.status,
        statusText: req.response.statusText,
        headers: req.response.headers.map((h) => ({
          name: h.name,
          value: h.value,
        })),
      },
    };

    if (req.responseBody) {
      example.response.body = {
        type: guessResponseBodyType(req.response.mimeType),
        data: req.responseBody,
      };
    }

    if (req.postData) {
      example.request.body = buildRequestBody(req.postData, req.requestHeaders);
    }

    item.examples = [example];
  }

  // Smart mode: attach after-response script
  if (meta && meta.postScriptLines.length > 0) {
    const code = `// Auto-generated: extract values for subsequent requests\n${meta.postScriptLines.join("\n")}`;
    item.runtime = {
      scripts: [{ type: "after-response", code }],
    };
  }

  return item;
}

function buildWebSocketItem(req, idx, meta) {
  const replacements = meta ? meta.replacements : new Map();
  const urlObj = parseUrl(req.url);
  return {
    info: {
      name: `WS ${urlObj.pathname}`,
      type: "websocket",
      seq: idx + 1,
    },
    websocket: {
      url: applyReplacements(req.url, replacements),
    },
  };
}

function buildRequestBody(postData, headers) {
  const contentType =
    headers.find((h) => h.name.toLowerCase() === "content-type")?.value || "";

  if (contentType.includes("application/json")) {
    return { type: "json", data: postData };
  }
  if (
    contentType.includes("application/xml") ||
    contentType.includes("text/xml")
  ) {
    return { type: "xml", data: postData };
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    try {
      const params = new URLSearchParams(postData);
      const data = [];
      for (const [name, value] of params) {
        data.push({ name, value });
      }
      return { type: "form-urlencoded", data };
    } catch {
      return { type: "text", data: postData };
    }
  }
  return { type: "text", data: postData };
}

function guessResponseBodyType(mimeType) {
  if (!mimeType) return "text";
  if (mimeType.includes("json")) return "json";
  if (mimeType.includes("xml")) return "xml";
  if (mimeType.includes("html")) return "html";
  return "text";
}

function parseUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const params = [];
    for (const [name, value] of u.searchParams) {
      params.push({ name, value });
    }
    return { pathname: u.pathname, params };
  } catch {
    return { pathname: urlStr, params: [] };
  }
}

// ─── Smart Mode: Dependency Detection ─────────────────────────────────────────

/** Minimum length for a value to be considered an extractable token/ID */
const MIN_EXTRACTABLE_LEN = 4;

/** Keys whose values are typically carried across requests */
const INTERESTING_KEYS =
  /^(id|_id|uid|uuid|token|access[_-]?token|refresh[_-]?token|session[_-]?id|csrf|api[_-]?key|secret|authorization|key|slug|code|nonce|location|url|href|redirect|next)$/i;

/** Looks like a token, UUID, or non-trivial ID */
function looksLikeId(value) {
  if (typeof value !== "string") return false;
  if (value.length < MIN_EXTRACTABLE_LEN) return false;
  // UUID pattern
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    return true;
  // Numeric ID
  if (/^\d{2,}$/.test(value)) return true;
  // JWT or long base64-ish token (at least 20 chars, mostly alphanumeric)
  if (value.length >= 20 && /^[A-Za-z0-9_.\-+=\/]+$/.test(value)) return true;
  return false;
}

/**
 * Recursively walk a JSON object and extract key→value pairs that look like
 * useful identifiers/tokens. Returns array of { path, value, varName }.
 */
function extractValues(obj, prefix) {
  const results = [];
  if (obj == null || typeof obj !== "object") return results;

  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      results.push(...extractValues(item, `${prefix}[${i}]`));
    });
    return results;
  }

  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === "object") {
      results.push(...extractValues(val, path));
    } else if (typeof val === "string" && val.length >= MIN_EXTRACTABLE_LEN) {
      if (INTERESTING_KEYS.test(key) || looksLikeId(val)) {
        // Build a clean variable name from the path
        const varName = path
          .replace(/^res\.body\.?/, "")
          .replace(/\[(\d+)\]/g, "_$1")
          .replace(/[^a-zA-Z0-9_]/g, "_")
          .replace(/^_+|_+$/g, "")
          .replace(/_+/g, "_");
        results.push({ path, value: val, varName });
      }
    } else if (typeof val === "number" && String(val).length >= 2) {
      if (INTERESTING_KEYS.test(key)) {
        const varName = path
          .replace(/\[(\d+)\]/g, "_$1")
          .replace(/[^a-zA-Z0-9_]/g, "_")
          .replace(/_+/g, "_");
        results.push({ path, value: String(val), varName });
      }
    }
  }
  return results;
}

/**
 * Extract interesting values from response headers.
 */
function extractHeaderValues(headers) {
  const results = [];
  const interestingHeaders =
    /^(location|x-csrf-token|x-request-id|x-correlation-id|etag)$/i;
  for (const { name, value } of headers) {
    if (
      interestingHeaders.test(name) &&
      value &&
      value.length >= MIN_EXTRACTABLE_LEN
    ) {
      const varName = `resp_header_${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
      results.push({
        path: `res.getHeader("${name}")`,
        value,
        varName,
        isHeader: true,
      });
    }
  }
  return results;
}

/**
 * Check if a value appears in a request's URL, headers, or body.
 * Returns array of { location, detail } describing where the match was found.
 */
function findValueInRequest(req, value) {
  const matches = [];
  const strValue = String(value);
  if (strValue.length < MIN_EXTRACTABLE_LEN) return matches;

  // Check URL
  if (req.url && req.url.includes(strValue)) {
    matches.push({ location: "url", detail: req.url });
  }

  // Check request headers
  for (const h of req.requestHeaders || []) {
    if (h.value && h.value.includes(strValue)) {
      matches.push({ location: "header", detail: h.name });
    }
  }

  // Check request body
  if (req.postData && req.postData.includes(strValue)) {
    matches.push({ location: "body", detail: "request body" });
  }

  return matches;
}

/**
 * Run smart dependency detection across all captured requests.
 * Returns a Map<requestIndex, { postScripts: string[], preScripts: string[], replacements: Map<literal, varName> }>
 */
function detectDependencies(requests) {
  // Per-request metadata
  const meta = requests.map(() => ({
    postScriptLines: [], // lines of code for after-response script
    replacements: new Map(), // literal value → {{varName}} for this request
  }));

  // Deduplicate: track which varNames have been assigned to avoid conflicts
  const usedVarNames = new Set();
  // Track which values we've already wired up (value → varName)
  const wiredValues = new Map();

  for (let srcIdx = 0; srcIdx < requests.length; srcIdx++) {
    const srcReq = requests[srcIdx];
    if (!srcReq.response) continue;

    // Collect extractable values from response body
    let bodyValues = [];
    if (srcReq.responseBody) {
      try {
        const parsed = JSON.parse(srcReq.responseBody);
        bodyValues = extractValues(parsed, "res.body");
      } catch {
        // Not JSON — skip body extraction
      }
    }

    // Collect extractable values from response headers
    const headerValues = srcReq.response.headers
      ? extractHeaderValues(srcReq.response.headers)
      : [];

    const allValues = [...bodyValues, ...headerValues];

    // For each extractable value, check if it appears in any subsequent request
    for (const extracted of allValues) {
      // Skip if already wired to same value
      if (wiredValues.has(extracted.value)) {
        // Still check subsequent requests for this value
        const existingVar = wiredValues.get(extracted.value);
        for (let tgtIdx = srcIdx + 1; tgtIdx < requests.length; tgtIdx++) {
          const hits = findValueInRequest(requests[tgtIdx], extracted.value);
          if (hits.length > 0) {
            meta[tgtIdx].replacements.set(extracted.value, existingVar);
          }
        }
        continue;
      }

      let matched = false;
      for (let tgtIdx = srcIdx + 1; tgtIdx < requests.length; tgtIdx++) {
        const hits = findValueInRequest(requests[tgtIdx], extracted.value);
        if (hits.length > 0) {
          matched = true;
          // Ensure unique variable name
          let varName = extracted.varName;
          if (usedVarNames.has(varName)) {
            varName = `${varName}_${srcIdx}`;
          }
          usedVarNames.add(varName);
          wiredValues.set(extracted.value, varName);

          // Add post-response script line to source request
          const accessor = extracted.isHeader
            ? extracted.path
            : extracted.path.replace(/^res\.body/, "res.body");
          meta[srcIdx].postScriptLines.push(
            `bru.setVar("${varName}", ${accessor});`,
          );

          // Mark replacement in this and all subsequent matching requests
          meta[tgtIdx].replacements.set(extracted.value, varName);
          for (
            let futureIdx = tgtIdx + 1;
            futureIdx < requests.length;
            futureIdx++
          ) {
            const futureHits = findValueInRequest(
              requests[futureIdx],
              extracted.value,
            );
            if (futureHits.length > 0) {
              meta[futureIdx].replacements.set(extracted.value, varName);
            }
          }
          break; // Only need to wire once per extracted value
        }
      }
    }
  }

  return meta;
}

/**
 * Apply replacements to a string: replace literal values with {{varName}} placeholders.
 */
function applyReplacements(str, replacements) {
  if (!str || replacements.size === 0) return str;
  let result = str;
  // Sort by value length descending to replace longer matches first
  const sorted = [...replacements.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [literal, varName] of sorted) {
    // Use split+join for safe replacement (no regex special char issues)
    result = result.split(literal).join(`{{${varName}}}`);
  }
  return result;
}

// ─── Open Viewer ──────────────────────────────────────────────────────────────

function openViewer(collection) {
  const json = JSON.stringify(collection);
  chrome.storage.local.set({ _viewerCollection: json }, () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
  });
}

// ─── Icon updates ─────────────────────────────────────────────────────────────

function updateIcon(isRecording) {
  const state = isRecording ? "on" : "off";
  chrome.action.setIcon({
    path: {
      16: `icons/icon-${state}-16.png`,
      48: `icons/icon-${state}-48.png`,
      128: `icons/icon-${state}-128.png`,
    },
  });
}

// ─── Badge ────────────────────────────────────────────────────────────────────

function updateBadge() {
  if (recording) {
    chrome.action.setBadgeText({ text: String(capturedRequests.length) });
    chrome.action.setBadgeBackgroundColor({ color: "#f5a623" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// ─── Icon click = toggle recording ───────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  if (recording) {
    await stopRecording();
    updateBadge();
    return;
  }
  if (!tab.id) return;
  // Load preferences from storage before starting
  const stored = await chrome.storage.local.get([
    "smartMode",
    "filterApi",
    "filterDocuments",
    "filterWebSocket",
    "filterExcludeRegex",
  ]);
  smartMode = !!stored.smartMode;
  filterApi = stored.filterApi !== false; // default true
  filterDocuments = stored.filterDocuments !== false; // default true
  filterWebSocket = stored.filterWebSocket !== false; // default true
  filterExcludeRegex = stored.filterExcludeRegex || "";
  try {
    await startRecording(tab.id);
    updateBadge();
  } catch (err) {
    console.error("Failed to start recording:", err);
  }
});

// ─── Message handling (options page) ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getState") {
    sendResponse({ recording, smartMode });
    return false;
  }
  if (msg.type === "setSmartMode") {
    smartMode = !!msg.enabled;
    chrome.storage.local.set({ smartMode });
    sendResponse({ smartMode });
    return false;
  }
  if (msg.type === "setFilters") {
    if (msg.filterApi !== undefined) filterApi = !!msg.filterApi;
    if (msg.filterDocuments !== undefined)
      filterDocuments = !!msg.filterDocuments;
    if (msg.filterWebSocket !== undefined)
      filterWebSocket = !!msg.filterWebSocket;
    if (msg.filterExcludeRegex !== undefined)
      filterExcludeRegex = String(msg.filterExcludeRegex || "");
    chrome.storage.local.set({
      filterApi,
      filterDocuments,
      filterWebSocket,
      filterExcludeRegex,
    });
    sendResponse({
      filterApi,
      filterDocuments,
      filterWebSocket,
      filterExcludeRegex,
    });
    return false;
  }
  return false;
});

// Clean up if the recorded tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === attachedTabId) {
    stopRecording();
  }
});

// Clean up if debugger is detached externally (user clicked the infobar dismiss)
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === attachedTabId) {
    recording = false;
    attachedTabId = null;
    updateIcon(false);
    updateBadge();
  }
});
