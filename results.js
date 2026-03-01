// results.js — Reads raw products from chrome.storage, scores client-side, renders grid

(function () {
  var rawProducts = [];
  var allScored = [];
  var amazonUrl = '';
  var currentMode = 'bayesian';
  var statsData = null;
  var CURR = { USD: '$', MXN: 'MX$', GBP: '\u00a3', EUR: '\u20ac', JPY: '\u00a5', INR: '\u20b9', BRL: 'R$', CAD: 'CA$', AUD: 'A$', SGD: 'S$', PLN: 'z\u0142', SEK: 'kr', SAR: 'SAR', AED: 'AED' };
  var MODE_NAMES = { bayesian: 'BayesScore', popular: 'Popular', value: 'Value', premium: 'Premium Gems' };
  var MODE_ICONS = { bayesian: '\ud83d\udcca', popular: '\ud83d\udd25', value: '\ud83d\udcb0', premium: '\ud83d\udc8e' };

  // ===================== SCORING ENGINE =====================

  function computeBayesBase(items) {
    var totalWR = 0, totalR = 0;
    items.forEach(function (p) { totalWR += p.rating * p.reviewCount; totalR += p.reviewCount; });
    var C = totalR > 0 ? totalWR / totalR : 0;
    var counts = items.map(function (p) { return p.reviewCount; }).sort(function (a, b) { return a - b; });
    var m = Math.max(counts[Math.floor(counts.length * 0.25)] || 1, 50);
    items.forEach(function (p) {
      var v = p.reviewCount, R = p.rating;
      p._bayesRaw = (v / (v + m)) * R + (m / (v + m)) * C;
      p.confidence = Math.round((v / (v + m)) * 100);
    });
    return { C: C, m: m };
  }

  function finalize(items) {
    items.sort(function (a, b) {
      var diff = b.bayesScore - a.bayesScore;
      if (diff !== 0) return diff;
      // Tiebreaker: more reviews = more trustworthy = ranks higher
      return b.reviewCount - a.reviewCount;
    });
    items.forEach(function (p, i) { p.rank = i + 1; });
    return items;
  }

  function cloneProducts(arr) {
    return arr.map(function (p) {
      var c = {};
      for (var k in p) { if (p.hasOwnProperty(k)) c[k] = p[k]; }
      return c;
    });
  }

  function scoreBayesian(items) {
    computeBayesBase(items);
    items.forEach(function (p) { p.bayesScore = Math.round(p._bayesRaw * 1000) / 1000; });
    return finalize(items);
  }

  function scorePopular(items) {
    computeBayesBase(items);
    var maxRev = 1;
    items.forEach(function (p) { if (p.reviewCount > maxRev) maxRev = p.reviewCount; });
    var logMax = Math.log10(maxRev);
    items.forEach(function (p) {
      var popBoost = logMax > 0 ? (1 + Math.log10(p.reviewCount) / logMax) : 1;
      p.bayesScore = Math.round(p._bayesRaw * popBoost * 1000) / 1000;
    });
    return finalize(items);
  }

  function scoreValue(items) {
    // Value = quality per price, weighted by confidence.
    // sqrt(confidence) ensures well-reviewed products rank above low-review ones,
    // without completely crushing products with moderate reviews.
    var withPrice = items.filter(function (p) { return p.price > 0 && p.reviewCount >= 20; });
    if (withPrice.length === 0) return [];
    computeBayesBase(withPrice);
    withPrice.forEach(function (p) {
      var pricePenalty = Math.log10(p.price + 1);
      var confFactor = Math.sqrt(p.confidence / 100);
      p.bayesScore = Math.round((p._bayesRaw * confFactor / pricePenalty) * 1000) / 1000;
    });
    return finalize(withPrice);
  }

  function scorePremium(items) {
    var candidates = items.filter(function (p) { return p.price > 0 && p.rating >= 4.0 && p.reviewCount >= 5; });
    if (candidates.length === 0) return [];
    var revCounts = candidates.map(function (p) { return p.reviewCount; }).sort(function (a, b) { return a - b; });
    var median = revCounts[Math.floor(revCounts.length / 2)] || 1;
    candidates = candidates.filter(function (p) { return p.reviewCount <= median; });
    if (candidates.length === 0) return [];
    // Price rank: higher price = higher rank (0 to 1)
    var byPrice = candidates.slice().sort(function (a, b) { return a.price - b.price; });
    var priceRankMap = {};
    byPrice.forEach(function (p, i) { priceRankMap[p.asin] = (i + 1) / byPrice.length; });
    // Review confidence: more reviews = more trustworthy (small bonus via log)
    var maxRev = 1;
    candidates.forEach(function (p) { if (p.reviewCount > maxRev) maxRev = p.reviewCount; });
    candidates.forEach(function (p) {
      var priceRank = priceRankMap[p.asin] || 0.5;
      var revBonus = 1 + (Math.log10(p.reviewCount) / Math.log10(maxRev + 1));
      p.bayesScore = Math.round((p.rating * priceRank * revBonus) * 1000) / 1000;
      p.confidence = Math.round((p.reviewCount / maxRev) * 100);
    });
    return finalize(candidates);
  }

  function scoreWithMode(mode) {
    var items = cloneProducts(rawProducts);
    switch (mode) {
      case 'popular': return scorePopular(items);
      case 'value':   return scoreValue(items);
      case 'premium': return scorePremium(items);
      default:        return scoreBayesian(items);
    }
  }

  // ===================== UI HELPERS =====================

  function showError(msg) {
    document.getElementById('loading').style.display = 'none';
    var el = document.getElementById('error');
    el.style.display = 'block';
    el.textContent = msg;
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function fmtNum(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return '' + n;
  }

  function updateSubtitle() {
    var query = statsData ? statsData.query || 'Search' : 'Search';
    var elapsed = statsData && statsData.stats ? (statsData.stats.elapsedMs / 1000).toFixed(1) + 's' : '';
    var icon = MODE_ICONS[currentMode] || '\ud83d\udcca';
    var name = MODE_NAMES[currentMode] || 'BayesScore';
    document.getElementById('subtitle').textContent = icon + ' ' + name + ' \u2014 "' + query + '" \u2014 ' + allScored.length + ' products \u2014 ' + elapsed;
  }

  // ===================== RENDER =====================

  function renderGrid(items) {
    var grid = document.getElementById('grid');
    grid.innerHTML = '';
    var domain = 'https://www.amazon.com';
    try { domain = (new URL(amazonUrl)).origin; } catch (e) { /* keep default */ }

    for (var i = 0; i < items.length && i < 300; i++) {
      var p = items[i];
      var rc = p.rank <= 3 ? 'r' + p.rank : 'rn';
      var sc = p.bayesScore >= 4.5 ? 'sc-e' : p.bayesScore >= 4.0 ? 'sc-g' : p.bayesScore >= 3.5 ? 'sc-a' : 'sc-p';
      var cur = CURR[p.currency] || '$';

      var full = Math.floor(p.rating);
      var half = (p.rating - full) >= 0.3;
      var stars = '';
      for (var j = 0; j < full; j++) stars += '\u2605';
      if (half) stars += '\u00bd';
      for (var k = full + (half ? 1 : 0); k < 5; k++) stars += '\u2606';

      var card = document.createElement('div');
      card.className = 'card' + (p.rank <= 3 ? ' top3' : '');

      var html = '<div class="card-top">';
      html += '<div class="card-rank ' + rc + '">' + p.rank + '</div>';
      if (p.imageUrl) {
        html += '<img class="card-img" src="' + esc(p.imageUrl) + '" loading="lazy">';
      }
      html += '<div class="card-info">';
      html += '<div class="card-title">' + esc(p.title) + '</div>';
      html += '<div class="card-meta">';
      html += '<span class="stars">' + stars + ' ' + p.rating + '</span>';
      html += '<span>' + fmtNum(p.reviewCount) + ' rev</span>';
      if (p.discount > 0) html += '<span class="green">-' + p.discount + '%</span>';
      if (p.badge) html += '<span class="badge-tag">' + esc(p.badge) + '</span>';
      html += '</div></div></div>';

      html += '<div class="card-bottom">';
      html += '<div class="card-price">';
      html += p.price > 0 ? cur + p.price.toFixed(2) : '\u2014';
      if (p.listPrice > 0) html += '<span class="old">' + cur + p.listPrice.toFixed(2) + '</span>';
      html += '</div>';
      html += '<div style="text-align:right"><div class="score-num ' + sc + '">' + p.bayesScore.toFixed(2) + '</div>';
      html += '<div class="score-conf">' + p.confidence + '% conf</div></div>';
      html += '</div>';

      card.innerHTML = html;
      card.onclick = (function (url) {
        return function () { window.open(domain + url, '_blank'); };
      })(p.productUrl);
      grid.appendChild(card);
    }
  }

  function applyFilters() {
    var activeBtn = document.querySelector('.filter-btn.active');
    var f = activeBtn ? activeBtn.getAttribute('data-f') : 'all';
    var q = document.getElementById('search').value.toLowerCase();
    var s = document.getElementById('sort').value;
    var items = allScored.slice();

    if (f === 'top15') items = items.slice(0, 15);
    else if (f === 'highconf') items = items.filter(function (p) { return p.confidence >= 75; });
    else if (f === 'deals') items = items.filter(function (p) { return p.discount > 0; });

    if (q) items = items.filter(function (p) { return p.title.toLowerCase().indexOf(q) !== -1; });

    if (s === 'rating') items.sort(function (a, b) { return b.rating - a.rating; });
    else if (s === 'reviewCount') items.sort(function (a, b) { return b.reviewCount - a.reviewCount; });
    else if (s === 'price-asc') items.sort(function (a, b) { return (a.price || 9999) - (b.price || 9999); });
    else if (s === 'price-desc') items.sort(function (a, b) { return (b.price || 0) - (a.price || 0); });
    else if (s === 'discount') items.sort(function (a, b) { return b.discount - a.discount; });
    else items.sort(function (a, b) { return b.bayesScore - a.bayesScore; });

    renderGrid(items);
  }

  function switchMode(mode) {
    currentMode = mode;
    allScored = scoreWithMode(mode);
    updateSubtitle();
    applyFilters();

    // Update mode button count indicators
    var btns = document.querySelectorAll('.mode-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.remove('active');
      if (btns[i].getAttribute('data-mode') === mode) btns[i].classList.add('active');
    }
  }

  function exportFile(type) {
    var content, filename, mime;
    if (type === 'csv') {
      var rows = ['Rank,ASIN,Title,Score,Rating,Reviews,Price,Currency,Discount,Confidence,Badge,URL,Mode'];
      allScored.forEach(function (p) {
        rows.push([
          p.rank, p.asin,
          '"' + (p.title || '').replace(/"/g, '""') + '"',
          p.bayesScore, p.rating, p.reviewCount, p.price, p.currency,
          p.discount, p.confidence,
          '"' + (p.badge || '') + '"',
          p.productUrl, currentMode
        ].join(','));
      });
      content = rows.join('\n');
      filename = currentMode + '-results.csv';
      mime = 'text/csv';
    } else {
      content = JSON.stringify({ mode: currentMode, products: allScored }, null, 2);
      filename = currentMode + '-results.json';
      mime = 'application/json';
    }
    var blob = new Blob([content], { type: mime });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ===================== INIT =====================

  function initPage(data) {
    document.getElementById('loading').style.display = 'none';

    if (!data || (!data.rawProducts && !data.scored) || (data.rawProducts || data.scored).length === 0) {
      showError('No results found. Run an extraction from an Amazon search page first.');
      return;
    }

    // Use rawProducts if available, fall back to scored for backward compat
    rawProducts = data.rawProducts || data.scored;
    amazonUrl = data.url || '';
    statsData = data;

    // Initial scoring with default mode
    allScored = scoreWithMode('bayesian');
    updateSubtitle();

    // Stats bar
    var sb = document.getElementById('stats-bar');
    sb.style.display = 'flex';
    var elapsed = data.stats ? (data.stats.elapsedMs / 1000).toFixed(1) + 's' : '';
    var failedHtml = '';
    if (data.stats && data.stats.pagesFailed > 0) {
      failedHtml = '<div><div class="stat-value" style="color:#e17055">' + data.stats.pagesFailed + '</div><div class="stat-label">Failed</div></div>';
    }
    var captchaHtml = '';
    if (data.stats && data.stats.captchaHit) {
      captchaHtml = '<div><div class="stat-value" style="color:#d63031">!</div><div class="stat-label">CAPTCHA Hit</div></div>';
    }
    sb.innerHTML =
      '<div><div class="stat-value">' + rawProducts.length + '</div><div class="stat-label">Products</div></div>' +
      '<div><div class="stat-value">' + (data.stats ? data.stats.pagesSucceeded : '-') + '</div><div class="stat-label">Pages OK</div></div>' +
      failedHtml + captchaHtml +
      '<div><div class="stat-value">' + elapsed + '</div><div class="stat-label">Time</div></div>';

    // Show mode bar and controls
    document.getElementById('mode-bar').style.display = 'flex';
    document.getElementById('controls').style.display = 'flex';

    // Render initial grid
    renderGrid(allScored);

    // --- Event listeners ---

    // Mode buttons
    var modeBtns = document.querySelectorAll('.mode-btn');
    for (var i = 0; i < modeBtns.length; i++) {
      modeBtns[i].addEventListener('click', function () {
        switchMode(this.getAttribute('data-mode'));
      });
    }

    // Filter buttons
    var filterBtns = document.querySelectorAll('.filter-btn');
    for (var j = 0; j < filterBtns.length; j++) {
      filterBtns[j].addEventListener('click', function () {
        for (var k = 0; k < filterBtns.length; k++) filterBtns[k].classList.remove('active');
        this.classList.add('active');
        applyFilters();
      });
    }

    document.getElementById('search').addEventListener('input', applyFilters);
    document.getElementById('sort').addEventListener('change', applyFilters);
    document.getElementById('btn-csv').addEventListener('click', function () { exportFile('csv'); });
    document.getElementById('btn-json').addEventListener('click', function () { exportFile('json'); });
  }

  // ===== LOAD DATA =====
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get('lastResults', function (result) {
      if (chrome.runtime.lastError) {
        showError('Storage error: ' + chrome.runtime.lastError.message);
        return;
      }
      initPage(result ? result.lastResults : null);
    });
  } else {
    showError('chrome.storage not available. Open this page from the extension.');
  }
})();
