// results.js — Reads raw products from chrome.storage, scores client-side, renders grid

(function () {
  // ===================== DARK MODE =====================
  (function initTheme() {
    var toggle = document.getElementById('theme-toggle');
    var isDark = localStorage.getItem('bayesscore-dark') === '1';

    function applyTheme(dark) {
      if (dark) {
        document.body.classList.add('dark');
        toggle.textContent = 'Light';
        toggle.title = 'Switch to light mode';
      } else {
        document.body.classList.remove('dark');
        toggle.textContent = 'Dark';
        toggle.title = 'Switch to dark mode';
      }
    }

    applyTheme(isDark);
    toggle.addEventListener('click', function () {
      isDark = !isDark;
      localStorage.setItem('bayesscore-dark', isDark ? '1' : '0');
      applyTheme(isDark);
    });
  })();

  var rawProducts = [];
  var allScored = [];
  var amazonUrl = '';
  var currentMode = 'bayesian';
  var statsData = null;
  var CURR = { USD: '$', MXN: 'MX$', GBP: '\u00a3', EUR: '\u20ac', JPY: '\u00a5', INR: '\u20b9', BRL: 'R$', CAD: 'CA$', AUD: 'A$', SGD: 'S$', PLN: 'z\u0142', SEK: 'kr', SAR: 'SAR', AED: 'AED' };
  var MODE_NAMES = { bayesian: 'BayesScore', popular: 'Popular', value: 'Value', premium: 'Premium Gems', quality: 'True Quality' };
  var MODE_ICONS = { bayesian: '\ud83d\udcca', popular: '\ud83d\udd25', value: '\ud83d\udcb0', premium: '\ud83d\udc8e', quality: '\ud83c\udfaf' };

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

  // --- Mode 5: True Quality (anti-herd, rewards genuine quality over popularity) ---
  function scoreTrueQuality(items) {
    if (items.length === 0) return [];

    // Global stats
    var totalWR = 0, totalR = 0;
    items.forEach(function (p) { totalWR += p.rating * p.reviewCount; totalR += p.reviewCount; });
    var C = totalR > 0 ? totalWR / totalR : 0;

    var counts = items.map(function (p) { return p.reviewCount; }).sort(function (a, b) { return a - b; });
    var m = Math.max(counts[Math.floor(counts.length * 0.25)] || 1, 50);

    // Saturation cap: 75th percentile — beyond this, more reviews give diminishing returns
    var satCap = Math.max(counts[Math.floor(counts.length * 0.75)] || 100, 100);

    items.forEach(function (p) {
      var v = p.reviewCount;
      var R = p.rating;

      // Effective reviews: full value up to satCap, log-compressed beyond
      var effV = v <= satCap ? v : satCap + Math.log10(1 + v - satCap) * satCap * 0.1;

      // Capped Bayesian — rating matters more, review volume matters less
      p._bayesRaw = (effV / (effV + m)) * R + (m / (effV + m)) * C;
      p.confidence = Math.round((effV / (effV + m)) * 100);

      var mult = 1.0;

      // Sponsored penalty: paid visibility ≠ earned quality
      if (p.isSponsored) mult *= 0.88;

      // Discount skepticism: heavy discounts suggest price-driven sales
      if (p.discount > 50) mult *= 0.92;
      else if (p.discount > 30) mult *= 0.96;

      // Freshness boost: recent purchases signal active demand
      if (p.boughtCount > 0 && v > 0) {
        var buyRatio = Math.min(p.boughtCount / v, 2);
        mult *= 1 + 0.05 * buyRatio;
      }

      p.bayesScore = Math.round(p._bayesRaw * mult * 1000) / 1000;
    });

    return finalize(items);
  }

  // ===================== VARIANT DEDUPLICATION =====================

  function deduplicateVariants(products) {
    // Union-Find to group color/size variants into families
    var parent = {};
    function find(x) {
      if (!parent[x]) parent[x] = x;
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }
    function union(a, b) {
      var ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }

    // Build unions from siblingAsins
    products.forEach(function (p) {
      if (p.siblingAsins && p.siblingAsins.length > 0) {
        p.siblingAsins.forEach(function (sib) { union(p.asin, sib); });
      }
    });

    // Group products by their root
    var groups = {};
    products.forEach(function (p) {
      var root = find(p.asin);
      if (!groups[root]) groups[root] = [];
      groups[root].push(p);
    });

    // Pick cheapest from each group (products without price go last)
    var result = [];
    Object.keys(groups).forEach(function (root) {
      var group = groups[root];
      if (group.length === 1) { result.push(group[0]); return; }
      group.sort(function (a, b) {
        if (a.price > 0 && b.price > 0) return a.price - b.price;
        if (a.price > 0) return -1;
        if (b.price > 0) return 1;
        return 0;
      });
      result.push(group[0]);
    });

    return result;
  }

  function scoreWithMode(mode) {
    var items = deduplicateVariants(cloneProducts(rawProducts));
    switch (mode) {
      case 'popular': return scorePopular(items);
      case 'value':   return scoreValue(items);
      case 'premium': return scorePremium(items);
      case 'quality': return scoreTrueQuality(items);
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
    var name = MODE_NAMES[currentMode] || 'BayesScore';
    document.getElementById('subtitle').textContent = name + ' \u2014 "' + query + '" \u2014 ' + allScored.length + ' products \u2014 ' + elapsed;
  }

  // ===================== RENDER =====================

  function renderGrid(items) {
    var grid = document.getElementById('grid');
    grid.innerHTML = '';
    var domain = 'https://www.amazon.com';
    try { domain = (new URL(amazonUrl)).origin; } catch (e) { /* keep default */ }

    var scaleMax = (currentMode === 'bayesian' || currentMode === 'popular' || currentMode === 'quality') ? 5 : (items.length > 0 ? items[0].bayesScore : 5);
    if (scaleMax === 0) scaleMax = 1;

    for (var i = 0; i < items.length && i < 300; i++) {
      var p = items[i];
      var rc = p.rank <= 3 ? 'r' + p.rank : 'rn';
      var sc = p.bayesScore >= 4.5 ? 'sc-e' : p.bayesScore >= 4.0 ? 'sc-g' : p.bayesScore >= 3.5 ? 'sc-a' : 'sc-p';
      var cur = CURR[p.currency] || '$';
      var scorePercent = Math.min(100, Math.round((p.bayesScore / scaleMax) * 100));

      var full = Math.floor(p.rating);
      var half = (p.rating - full) >= 0.3;
      var stars = '';
      for (var j = 0; j < full; j++) stars += '\u2605';
      if (half) stars += '\u00bd';
      for (var k = full + (half ? 1 : 0); k < 5; k++) stars += '\u2606';

      var badgeClass = 'generic';
      if (p.badge) {
        var bl = p.badge.toLowerCase();
        if (bl.indexOf('best seller') !== -1 || bl.indexOf('bestseller') !== -1) badgeClass = 'bestseller';
        else if (bl.indexOf('choice') !== -1) badgeClass = 'choice';
      }

      var card = document.createElement('div');
      card.className = 'card' + (p.rank <= 3 ? ' top3' : '');

      var html = '';

      // Card header: rank tag + title
      html += '<div class="card-header">';
      html += '<span class="card-rank ' + rc + '">' + p.rank + '</span>';
      html += '<div class="card-title">' + esc(p.title) + '</div>';
      html += '</div>';

      // Card body: image + meta
      html += '<div class="card-body">';
      if (p.imageUrl) {
        html += '<img class="card-img" src="' + esc(p.imageUrl) + '" loading="lazy">';
      }
      html += '<div class="card-meta">';
      html += '<div class="card-rating"><span class="stars">' + stars + '</span> ' + p.rating + ' <span class="meta-sep">&middot;</span> ' + fmtNum(p.reviewCount) + ' reviews</div>';
      if (p.boughtCount > 0) {
        html += '<div class="card-bought">' + fmtNum(p.boughtCount) + '+ bought this month</div>';
      }
      html += '<div class="card-tags">';
      if (p.badge) html += '<span class="badge-tag badge-' + badgeClass + '">' + esc(p.badge) + '</span>';
      html += '</div>';
      html += '</div></div>';

      // Card bottom: price + score with bar
      html += '<div class="card-bottom">';
      html += '<div class="card-price-area">';
      html += '<span class="card-price">' + (p.price > 0 ? cur + p.price.toFixed(2) : '\u2014') + '</span>';
      if (p.listPrice > 0 && p.listPrice > p.price) {
        html += '<span class="card-list-price">' + cur + p.listPrice.toFixed(2) + '</span>';
      }
      if (p.discount > 0) {
        html += '<span class="card-discount">-' + p.discount + '%</span>';
      }
      html += '</div>';
      html += '<div class="card-score-area">';
      html += '<div class="card-score-top"><span class="score-label">SCORE</span><span class="score-num ' + sc + '">' + p.bayesScore.toFixed(2) + '</span></div>';
      html += '<div class="score-bar"><div class="score-bar-fill ' + sc + '" style="width:' + scorePercent + '%"></div></div>';
      html += '<div class="score-conf">' + p.confidence + '% confidence</div>';
      html += '</div>';
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
    sb.innerHTML =
      '<span class="stat-pill"><strong>' + rawProducts.length + '</strong> products</span>' +
      '<span class="stat-pill"><strong>' + (data.stats ? data.stats.pagesSucceeded : '-') + '</strong> pages</span>' +
      (data.stats && data.stats.pagesFailed > 0 ? '<span class="stat-pill error"><strong>' + data.stats.pagesFailed + '</strong> failed</span>' : '') +
      (data.stats && data.stats.captchaHit ? '<span class="stat-pill error"><strong>!</strong> CAPTCHA</span>' : '') +
      '<span class="stat-pill"><strong>' + elapsed + '</strong></span>';

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
    var params = new URLSearchParams(window.location.search);
    var resultId = params.get('id');

    if (resultId) {
      loadFromKey('results_' + resultId);
    } else {
      // No ID in URL — try lastResultId pointer, then legacy lastResults
      chrome.storage.local.get('lastResultId', function (r) {
        if (r && r.lastResultId) {
          loadFromKey('results_' + r.lastResultId);
        } else {
          loadFromKey('lastResults');
        }
      });
    }
  } else {
    showError('chrome.storage not available. Open this page from the extension.');
  }

  function loadFromKey(storageKey) {
    chrome.storage.local.get(storageKey, function (result) {
      if (chrome.runtime.lastError) {
        showError('Storage error: ' + chrome.runtime.lastError.message);
        return;
      }
      initPage(result ? result[storageKey] : null);
    });
  }
})();
