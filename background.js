// ============================================================
// Service Worker — Background Script
// ============================================================

importScripts('lib/parser.js', 'lib/bayesian.js');

let extractionRunning = false;

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

    case 'openResults':
      chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
      sendResponse({ ok: true });
      return false;

    case 'getResults':
      chrome.storage.local.get('lastResults', (r) => {
        sendResponse(r?.lastResults || null);
      });
      return true;

    case 'extractionComplete':
      extractionRunning = false;
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
