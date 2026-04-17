// ============================================================
// Service Worker — Background Script
// ============================================================

importScripts('lib/parser.js', 'lib/bayesian.js');

let extractionRunning = false;

// Desktop UA rule for mobile browsers — forces Amazon to serve desktop HTML (~60 products/page
// instead of ~14 on mobile). Activated only during extraction, disabled after.
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const UA_RULE_ID = 1;

function enableDesktopUA() {
  if (!chrome.declarativeNetRequest) return Promise.resolve();
  // Cover both /s/query (search) and /dp/ (category discovery) requests.
  // Only active during extraction; cleaned up on complete/abort/startup.
  return chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [UA_RULE_ID, UA_RULE_ID + 1],
    addRules: [{
      id: UA_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'User-Agent', operation: 'set', value: DESKTOP_UA }]
      },
      condition: { urlFilter: '/s/query', resourceTypes: ['xmlhttprequest'] }
    }, {
      id: UA_RULE_ID + 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'User-Agent', operation: 'set', value: DESKTOP_UA }]
      },
      condition: { urlFilter: '/dp/', resourceTypes: ['xmlhttprequest'] }
    }]
  }).catch(() => {});
}

function disableDesktopUA() {
  if (!chrome.declarativeNetRequest) return Promise.resolve();
  return chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [UA_RULE_ID, UA_RULE_ID + 1]
  }).catch(() => {});
}

// Clean up any leftover rule from a previous session
disableDesktopUA();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'scoreProducts':
      handleScore(msg).then(sendResponse);
      return true;

    case 'getState':
      sendResponse({ running: extractionRunning });
      return false;

    case 'setRunning':
      extractionRunning = msg.running;
      sendResponse({ ok: true });
      return false;

    case 'enableDesktopUA':
      enableDesktopUA().then(() => sendResponse({ ok: true }));
      return true;

    case 'disableDesktopUA':
      disableDesktopUA().then(() => sendResponse({ ok: true }));
      return true;

    case 'openResults':
      chrome.tabs.create({ url: chrome.runtime.getURL('results.html') + (msg.resultId ? '?id=' + msg.resultId : '') });
      sendResponse({ ok: true });
      return false;

    case 'getResults':
      chrome.storage.local.get('lastResults', (r) => {
        sendResponse(r?.lastResults || null);
      });
      return true;

    case 'abort':
      extractionRunning = false;
      disableDesktopUA();
      sendResponse({ ok: true });
      return false;

    case 'extractionComplete':
      extractionRunning = false;
      disableDesktopUA();
      sendResponse({ ok: true });
      return false;

    case 'progress':
      extractionRunning = true;
      sendResponse({ ok: true });
      return false;

    case 'exportCSV':
      chrome.storage.local.get('lastResults', (r) => {
        const csv = r?.lastResults?.scored
          ? globalThis.BayesBayesian.exportCSV(r.lastResults.scored)
          : '';
        sendResponse({ csv });
      });
      return true;

    case 'exportJSON':
      chrome.storage.local.get('lastResults', (r) => {
        const json = r?.lastResults?.scored
          ? globalThis.BayesBayesian.exportJSON(r.lastResults.scored)
          : '';
        sendResponse({ json });
      });
      return true;

    default:
      sendResponse({ error: 'Unknown action' });
      return false;
  }
});

async function handleScore(msg) {
  const { products, stats, options = {} } = msg;

  const scored = globalThis.BayesBayesian.calculateBayesScore(products, {
    filterSponsored: options.filterSponsored !== false,
    minReviews: options.minReviews || 0,
    minPrice: options.minPrice || 0,
    maxPrice: options.maxPrice || Infinity
  });

  const summary = globalThis.BayesBayesian.getSummaryStats(scored);

  const data = {
    scored,
    stats,
    summary,
    timestamp: Date.now(),
    query: msg.query || '',
    url: msg.url || ''
  };

  // AWAIT storage write — must finish before results.html opens
  await chrome.storage.local.set({ lastResults: data });

  extractionRunning = false;
  return { success: true, count: scored.length };
}
