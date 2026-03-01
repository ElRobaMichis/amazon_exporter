(function() {
  'use strict';
  if (window.__bayesScoreInjected) return;
  window.__bayesScoreInjected = true;

  var abortController = null;

  var SORT_ORDERS = ['', '&s=review-rank', '&s=price-asc-rank', '&s=price-desc-rank', '&s=date-desc-rank'];
  var ELECTRONICS_FILTER = '&rh=n%3A172282';

  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (msg.action === 'triggerExtract') startExtraction(msg.options || {});
    if (msg.action === 'detectPages') {
      sendResponse({ pages: detectMaxPages() });
    }
  });

  function detectMaxPages() {
    var items = document.querySelectorAll('.s-pagination-item');
    var max = 0;
    for (var i = 0; i < items.length; i++) {
      var n = parseInt(items[i].textContent.trim().replace(/[.,\s]/g, ''), 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return max || 1;
  }

  async function startExtraction(options) {
    if (abortController) abortController.abort();
    abortController = new AbortController();

    var pages = options.pages || 5;
    var multiQuery = options.multiQuery || false;
    var electronicsFilter = options.electronicsFilter || false;
    var filterSponsored = options.filterSponsored !== false;
    var minReviews = options.minReviews || 0;
    var minPrice = options.minPrice || 0;
    var maxPrice = options.maxPrice || 0;

    var baseUrl = window.location.href.split('&page=')[0].split('?page=')[0];
    if (electronicsFilter && baseUrl.indexOf('rh=n') === -1) {
      baseUrl += (baseUrl.indexOf('?') !== -1 ? '&' : '?') + ELECTRONICS_FILTER.substring(1);
    }

    var sortOrders = multiQuery ? SORT_ORDERS : [''];
    var allProducts = new Map();
    var pagesCompleted = 0;
    var totalPages = pages * sortOrders.length;

    broadcast({ completed: 0, total: totalPages, newProducts: 0 });

    var tasks = [];
    for (var si = 0; si < sortOrders.length; si++) {
      for (var page = 1; page <= pages; page++) {
        var sep = baseUrl.indexOf('?') !== -1 ? '&' : '?';
        tasks.push(baseUrl + sep + 'page=' + page + sortOrders[si]);
      }
    }

    var startTime = Date.now();
    var BATCH_SIZE = 120;
    var BATCH_DELAY = 30; // ms between batches
    var MAX_RETRIES = 1;
    var succeeded = 0;
    var failed = 0;
    var captchaHit = false;

    // --- Fetch a single page with retry ---
    async function fetchPage(pageUrl, retries) {
      if (abortController.signal.aborted || captchaHit) return false;
      try {
        var r = await fetch(pageUrl, {
          signal: abortController.signal,
          credentials: 'include',
          headers: { 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9,es;q=0.8' }
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var html = await r.text();
        if (html.length < 5000 && html.indexOf('Type the characters') !== -1) {
          captchaHit = true;
          console.warn('[BayesScore] CAPTCHA detected! Stopping further requests.');
          return false;
        }
        var products = globalThis.BayesParser.parseProducts(html, window.location.hostname);
        var nc = 0;
        products.forEach(function(p) {
          if (!allProducts.has(p.asin)) { allProducts.set(p.asin, p); nc++; }
        });
        pagesCompleted++;
        succeeded++;
        broadcast({ completed: pagesCompleted, total: totalPages, newProducts: allProducts.size });
        return true;
      } catch (e) {
        if (retries > 0 && !captchaHit && !abortController.signal.aborted) {
          await delay(200 + Math.random() * 300);
          return fetchPage(pageUrl, retries - 1);
        }
        pagesCompleted++;
        failed++;
        broadcast({ completed: pagesCompleted, total: totalPages, newProducts: allProducts.size });
        return false;
      }
    }

    function delay(ms) {
      return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    // --- Process in batches ---
    for (var bi = 0; bi < tasks.length; bi += BATCH_SIZE) {
      if (abortController.signal.aborted || captchaHit) break;
      var batch = tasks.slice(bi, bi + BATCH_SIZE);
      await Promise.all(batch.map(function(url) { return fetchPage(url, MAX_RETRIES); }));
      // Delay between batches to avoid throttling
      if (bi + BATCH_SIZE < tasks.length && !captchaHit) {
        await delay(BATCH_DELAY);
      }
    }

    var elapsed = Date.now() - startTime;
    var products = Array.from(allProducts.values());

    // --- Filter and score with default mode (bayesian) ---
    var filtered = baseFilter(products, filterSponsored, minReviews, minPrice, maxPrice);
    var scored = scoreBayesian(filtered.map(function(p) { return Object.assign({}, p); }));
    var query = (new URL(window.location.href)).searchParams.get('k') || '';

    console.log('[BayesScore] Done:', succeeded + '/' + totalPages, 'pages OK,', failed, 'failed,', captchaHit ? 'CAPTCHA!' : 'no CAPTCHA,', products.length, 'raw,', filtered.length, 'filtered,', scored.length, 'scored in', (elapsed/1000).toFixed(1) + 's');

    // --- Store raw filtered products + default scored for results page ---
    var data = {
      rawProducts: filtered,
      scored: scored,
      stats: { pagesSucceeded: succeeded, pagesFailed: failed, totalPages: totalPages, elapsedMs: elapsed, captchaHit: captchaHit },
      scoringMode: 'bayesian',
      query: query,
      url: window.location.href,
      timestamp: Date.now()
    };

    // Also compute summary for popup display
    var avgSum = 0;
    scored.forEach(function(p) { avgSum += p.bayesScore; });
    data.summary = {
      maxScore: scored.length > 0 ? scored[0].bayesScore : 0,
      avgScore: scored.length > 0 ? Math.round((avgSum / scored.length) * 100) / 100 : 0
    };

    chrome.storage.local.set({ lastResults: data }, function() {
      console.log('[BayesScore] Data saved to storage, opening results...');
      // Notify popup about completion
      chrome.runtime.sendMessage({ action: 'extractionComplete', data: data }).catch(function() {});
      // Open results page
      chrome.runtime.sendMessage({ action: 'openResults' });
    });

    abortController = null;
  }

  function broadcast(progress) {
    chrome.runtime.sendMessage({ action: 'progress', progress: progress }).catch(function() {});
  }

  // ===================== SCORING ENGINE =====================

  function baseFilter(products, filterSponsored, minReviews, minPrice, maxPrice) {
    return products.filter(function(p) {
      if (filterSponsored && p.isSponsored) return false;
      if (p.reviewCount < minReviews) return false;
      if (maxPrice > 0 && p.price > maxPrice) return false;
      if (minPrice > 0 && p.price > 0 && p.price < minPrice) return false;
      if (p.rating === 0 || p.reviewCount === 0) return false;
      return true;
    });
  }

  function computeBayesBase(filtered) {
    var totalWR = 0, totalR = 0;
    filtered.forEach(function(p) { totalWR += p.rating * p.reviewCount; totalR += p.reviewCount; });
    var C = totalR > 0 ? totalWR / totalR : 0;
    var counts = filtered.map(function(p) { return p.reviewCount; }).sort(function(a, b) { return a - b; });
    var m = Math.max(counts[Math.floor(counts.length * 0.25)] || 1, 50);
    filtered.forEach(function(p) {
      var v = p.reviewCount, R = p.rating;
      p._bayesRaw = (v / (v + m)) * R + (m / (v + m)) * C;
      p.confidence = Math.round((v / (v + m)) * 100);
    });
    return { C: C, m: m };
  }

  function finalize(scored) {
    scored.sort(function(a, b) {
      var diff = b.bayesScore - a.bayesScore;
      if (diff !== 0) return diff;
      // Tiebreaker: more reviews = more trustworthy = ranks higher
      return b.reviewCount - a.reviewCount;
    });
    scored.forEach(function(p, i) { p.rank = i + 1; });
    return scored;
  }

  function scoreProducts(products, mode, filterSponsored, minReviews, minPrice, maxPrice) {
    var filtered = baseFilter(products, filterSponsored, minReviews, minPrice, maxPrice);
    if (filtered.length === 0) return [];

    switch (mode) {
      case 'popular':  return scorePopular(filtered);
      case 'value':    return scoreValue(filtered);
      case 'premium':  return scorePremium(filtered);
      default:         return scoreBayesian(filtered);
    }
  }

  // --- Mode 1: BayesScore (original) ---
  function scoreBayesian(filtered) {
    computeBayesBase(filtered);
    filtered.forEach(function(p) {
      p.bayesScore = Math.round(p._bayesRaw * 1000) / 1000;
    });
    return finalize(filtered);
  }

  // --- Mode 2: Popular (popularity bonus) ---
  function scorePopular(filtered) {
    computeBayesBase(filtered);
    var maxRev = 1;
    filtered.forEach(function(p) { if (p.reviewCount > maxRev) maxRev = p.reviewCount; });
    var logMax = Math.log10(maxRev);
    filtered.forEach(function(p) {
      var popBoost = logMax > 0 ? (1 + Math.log10(p.reviewCount) / logMax) : 1;
      p.bayesScore = Math.round(p._bayesRaw * popBoost * 1000) / 1000;
    });
    return finalize(filtered);
  }

  // --- Mode 3: Value (quality per price) ---
  function scoreValue(filtered) {
    // Value = quality per price, weighted by confidence.
    // sqrt(confidence) ensures well-reviewed products rank above low-review ones,
    // without completely crushing products with moderate reviews.
    var withPrice = filtered.filter(function(p) { return p.price > 0 && p.reviewCount >= 20; });
    if (withPrice.length === 0) return [];
    computeBayesBase(withPrice);
    withPrice.forEach(function(p) {
      var pricePenalty = Math.log10(p.price + 1);
      var confFactor = Math.sqrt(p.confidence / 100);
      p.bayesScore = Math.round((p._bayesRaw * confFactor / pricePenalty) * 1000) / 1000;
    });
    return finalize(withPrice);
  }

  // --- Mode 4: Premium Gems (expensive + high rating + few reviews) ---
  function scorePremium(filtered) {
    // Only products with price and rating >= 4.0
    var candidates = filtered.filter(function(p) { return p.price > 0 && p.rating >= 4.0 && p.reviewCount >= 5; });
    if (candidates.length === 0) return [];

    // Only keep products with reviewCount <= median (the "hidden" ones)
    var revCounts = candidates.map(function(p) { return p.reviewCount; }).sort(function(a, b) { return a - b; });
    var median = revCounts[Math.floor(revCounts.length / 2)] || 1;
    candidates = candidates.filter(function(p) { return p.reviewCount <= median; });
    if (candidates.length === 0) return [];

    // Sort by price to assign price rank (highest price = highest rank)
    var byPrice = candidates.slice().sort(function(a, b) { return a.price - b.price; });
    var priceRankMap = {};
    byPrice.forEach(function(p, i) { priceRankMap[p.asin] = (i + 1) / byPrice.length; });

    // Review confidence: more reviews = more trustworthy (small bonus via log)
    var maxRev = 1;
    candidates.forEach(function(p) { if (p.reviewCount > maxRev) maxRev = p.reviewCount; });
    candidates.forEach(function(p) {
      var priceRank = priceRankMap[p.asin] || 0.5;
      var revBonus = 1 + (Math.log10(p.reviewCount) / Math.log10(maxRev + 1));
      p.bayesScore = Math.round((p.rating * priceRank * revBonus) * 1000) / 1000;
      p.confidence = Math.round((p.reviewCount / maxRev) * 100);
    });
    return finalize(candidates);
  }


})();
