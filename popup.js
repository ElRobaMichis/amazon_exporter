// ============================================================
// Popup Script — Config panel logic
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const pagesSlider = document.getElementById('pages');
  const pagesValue = document.getElementById('pages-value');
  const multiQuery = document.getElementById('multiQuery');
  const depthAnalysis = document.getElementById('depthAnalysis');
  const filterSponsored = document.getElementById('filterSponsored');
  const minPrice = document.getElementById('minPrice');
  const maxPrice = document.getElementById('maxPrice');
  const minReviews = document.getElementById('minReviews');
  const extractBtn = document.getElementById('extractBtn');
  const abortBtn = document.getElementById('abortBtn');
  const statusText = document.getElementById('status-text');
  const statusBar = document.getElementById('status');
  const progressSection = document.getElementById('progress-section');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');
  const progressPct = document.getElementById('progress-pct');
  const resultsSection = document.getElementById('results-section');
  const modeAuto = document.getElementById('modeAuto');
  const modeManual = document.getElementById('modeManual');
  const sliderContainer = document.getElementById('slider-container');
  const detectedInfo = document.getElementById('detected-pages');

  let isAutoMode = true;
  let detectedPages = 0;

  // Auto-detect pages on popup open
  async function detectPages() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || !tab.url.includes('amazon')) {
        detectedInfo.innerHTML = '<strong>—</strong> (not on Amazon)';
        return;
      }
      // Try direct message first, inject only if needed
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { action: 'detectPages', prefetch: depthAnalysis.checked });
      } catch (e) {
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/parser.js', 'content.js'] });
          await new Promise(r => setTimeout(r, 100));
          response = await chrome.tabs.sendMessage(tab.id, { action: 'detectPages', prefetch: depthAnalysis.checked });
        } catch (e2) { /* injection failed */ }
      }
      if (response && response.pages > 0) {
        detectedPages = response.pages;
        detectedInfo.innerHTML = 'Detected: <strong>' + detectedPages + '</strong> pages';
      } else {
        detectedInfo.innerHTML = '<strong>—</strong> (no pagination)';
      }
    } catch (e) {
      detectedInfo.innerHTML = '<strong>—</strong>';
    }
  }

  async function triggerDepthPrefetch() {
    if (!depthAnalysis.checked) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || !tab.url.includes('amazon')) return;
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'prefetchDiscovery' });
      } catch (e) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/parser.js', 'content.js'] });
        await new Promise(r => setTimeout(r, 100));
        await chrome.tabs.sendMessage(tab.id, { action: 'prefetchDiscovery' });
      }
    } catch (e) { /* prefetch is best-effort */ }
  }

  // Mode toggle
  modeAuto.addEventListener('click', () => {
    isAutoMode = true;
    modeAuto.classList.add('active');
    modeManual.classList.remove('active');
    sliderContainer.classList.add('hidden');
    updateEstimate();
  });

  modeManual.addEventListener('click', () => {
    isAutoMode = false;
    modeManual.classList.add('active');
    modeAuto.classList.remove('active');
    sliderContainer.classList.remove('hidden');
    updateEstimate();
  });

  function getPages() {
    return isAutoMode ? (detectedPages || 1) : parseInt(pagesSlider.value);
  }

  function updateEstimate() {
    if (depthAnalysis.checked) {
      statusText.textContent = 'Depth analysis \u00b7 categories auto-discovered';
      return;
    }
    const pages = getPages();
    const queries = multiQuery.checked ? 5 : 1;
    const totalPages = pages * queries;
    statusText.textContent = `~${totalPages} pages \u2192 ~${totalPages * 16} products`;
  }

  // Load saved config
  chrome.storage.local.get('config', ({ config }) => {
    if (config) {
      pagesSlider.value = config.pages || 5;
      pagesValue.textContent = pagesSlider.value;
      multiQuery.checked = config.multiQuery || false;
      depthAnalysis.checked = config.depthAnalysis || false;
      filterSponsored.checked = config.filterSponsored !== false;
      minPrice.value = config.minPrice || 0;
      maxPrice.value = config.maxPrice || 0;
      minReviews.value = config.minReviews || 0;
      if (config.autoMode === false) {
        modeManual.click();
      }
    }
    detectPages();
  });

  // Slider update
  pagesSlider.addEventListener('input', () => {
    pagesValue.textContent = pagesSlider.value;
    updateEstimate();
  });

  multiQuery.addEventListener('change', () => {
    updateEstimate();
  });

  depthAnalysis.addEventListener('change', () => {
    updateEstimate();
    triggerDepthPrefetch();
  });

  // Save config on any change
  function saveConfig() {
    chrome.storage.local.set({
      config: {
        pages: parseInt(pagesSlider.value),
        autoMode: isAutoMode,
        multiQuery: multiQuery.checked,
        depthAnalysis: depthAnalysis.checked,
        filterSponsored: filterSponsored.checked,
        minPrice: parseFloat(minPrice.value) || 0,
        maxPrice: parseFloat(maxPrice.value) || 0,
        minReviews: parseInt(minReviews.value) || 0
      }
    });
  }

  [pagesSlider, multiQuery, depthAnalysis, filterSponsored, minPrice, maxPrice, minReviews]
    .forEach(el => el.addEventListener('change', saveConfig));

  // Extract button
  extractBtn.addEventListener('click', async () => {
    saveConfig();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('amazon')) {
      setStatus('Navigate to an Amazon search page first', 'error');
      return;
    }

    setExtracting(true);

    const extractOptions = {
      pages: getPages(),
      isAutoMode: isAutoMode,
      multiQuery: multiQuery.checked,
      depthAnalysis: depthAnalysis.checked,
      filterSponsored: filterSponsored.checked,
      minReviews: parseInt(minReviews.value) || 0,
      minPrice: parseFloat(minPrice.value) || 0,
      maxPrice: parseFloat(maxPrice.value) || 0
    };

    // Try sending directly first (scripts already loaded via manifest content_scripts)
    try {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'triggerExtract', options: extractOptions });
      } catch (msgErr) {
        // Content script not loaded — inject and retry
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['lib/parser.js', 'content.js']
        });
        await new Promise(r => setTimeout(r, 100));
        await chrome.tabs.sendMessage(tab.id, { action: 'triggerExtract', options: extractOptions });
      }
    } catch (e) {
      setExtracting(false);
      setStatus('Error: ' + e.message, 'error');
    }
  });

  // Abort button
  abortBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'abort' });
    setExtracting(false);
    setStatus('Extraction aborted', 'error');
  });

  // Listen for progress and results
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'progress') {
      updateProgress(msg.progress);
    } else if (msg.action === 'extractionComplete') {
      setExtracting(false);
      showResults(msg.data);
    }
  });

  // Check for existing results
  chrome.runtime.sendMessage({ action: 'getResults' }, (response) => {
    if (response && hasResultProducts(response)) {
      showResults(response);
    }
  });

  // Check if extraction is running
  chrome.runtime.sendMessage({ action: 'getState' }, (state) => {
    if (state && state.running) {
      setExtracting(true);
      updateProgress(state.progress);
    }
  });

  // Export buttons
  document.getElementById('exportCSV').addEventListener('click', async () => {
    const response = await chrome.runtime.sendMessage({ action: 'exportCSV' });
    downloadFile(response.csv, 'bayesscore.csv', 'text/csv');
  });

  document.getElementById('exportJSON').addEventListener('click', async () => {
    const response = await chrome.runtime.sendMessage({ action: 'exportJSON' });
    downloadFile(response.json, 'bayesscore.json', 'application/json');
  });

  document.getElementById('showPanel').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
    window.close();
  });

  // ---- Helpers ----
  function setStatus(text, type = '') {
    statusText.textContent = text;
    statusBar.className = 'status' + (type ? ' ' + type : '');
  }

  function setExtracting(running) {
    extractBtn.classList.toggle('hidden', running);
    abortBtn.classList.toggle('hidden', !running);
    progressSection.classList.toggle('hidden', !running);
    if (running) {
      setStatus('Extracting...', 'extracting');
    }
  }

  function updateProgress(progress) {
    if (progress.phase === 'discovery') {
      progressBar.style.width = '0%';
      progressText.textContent = `Analyzing products... (${progress.completed}/${progress.total})`;
      progressPct.textContent = '';
      return;
    }
    if (progress.phase === 'detection') {
      progressBar.style.width = '0%';
      progressText.textContent = `Found ${progress.categories} categories, preparing...`;
      progressPct.textContent = '';
      return;
    }
    const pct = progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;
    progressBar.style.width = pct + '%';
    progressText.textContent = `${progress.completed}/${progress.total} pages \u00b7 ${progress.newProducts} unique products`;
    progressPct.textContent = Math.round(pct) + '%';
  }

  function showResults(data) {
    if (!data || !hasResultProducts(data)) return;

    const preview = data.scored || data.scoredPreview || [];
    const productCount = data.scoredCount || preview.length || (data.rawProducts ? data.rawProducts.length : 0);

    resultsSection.classList.remove('hidden');
    setStatus(`${productCount} products ranked`, 'done');

    document.getElementById('res-products').textContent = productCount;
    document.getElementById('res-pages').textContent = data.stats?.pagesSucceeded || '—';
    document.getElementById('res-time').textContent = data.stats ? (data.stats.elapsedMs / 1000).toFixed(1) + 's' : '—';
    document.getElementById('res-best').textContent = data.summary ? data.summary.maxScore.toFixed(2) : '—';

    // Top 5
    const top5 = document.getElementById('top5');
    top5.innerHTML = '';
    preview.slice(0, 5).forEach((p, i) => {
      const item = document.createElement('div');
      item.className = 'top5-item';
      item.innerHTML = `
        <div class="top5-rank r${i + 1}">${i + 1}</div>
        <div class="top5-title" title="${escapeAttr(p.title)}">${escapeHtml(p.title)}</div>
        <div class="top5-score">${p.bayesScore.toFixed(2)}</div>
      `;
      top5.appendChild(item);
    });
  }

  function hasResultProducts(data) {
    return (data.scored && data.scored.length > 0)
      || (data.scoredPreview && data.scoredPreview.length > 0)
      || (data.rawProducts && data.rawProducts.length > 0);
  }

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
});
