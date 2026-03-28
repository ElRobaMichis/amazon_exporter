(function() {
  'use strict';
  if (window.__bayesScoreInjected) return;
  window.__bayesScoreInjected = true;

  var abortController = null;

  var SORT_ORDERS = ['', '&s=review-rank', '&s=price-asc-rank', '&s=price-desc-rank', '&s=date-desc-rank'];
  var DEPTH_SAMPLE_SIZE = 10;

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
    var depthAnalysis = options.depthAnalysis || false;
    var isAutoMode = options.isAutoMode !== false;
    var filterSponsored = options.filterSponsored !== false;
    var minReviews = options.minReviews || 0;
    var minPrice = options.minPrice || 0;
    var maxPrice = options.maxPrice || 0;

    var baseUrl = window.location.href.split('&page=')[0].split('?page=')[0];
    var hostname = window.location.hostname;
    var origin = window.location.origin;

    var sortOrders = multiQuery ? SORT_ORDERS : [''];
    var allProducts = new Map();
    var pagesCompleted = 0;
    var totalPages = 0;

    var startTime = Date.now();
    var BATCH_SIZE = 10;
    var BATCH_DELAY = 300;
    var consecutiveFailures = 0;
    var MAX_RETRIES = 1;
    var succeeded = 0;
    var failed = 0;
    var captchaHit = false;

    function delay(ms) {
      return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    // --- Fetch raw HTML with retry ---
    async function fetchHtml(url, retries) {
      if (abortController.signal.aborted || captchaHit) return null;
      try {
        var r = await fetch(url, {
          signal: abortController.signal,
          credentials: 'include',
          headers: { 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9,es;q=0.8' }
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var html = await r.text();
        if (html.length < 5000 && html.indexOf('Type the characters') !== -1) {
          captchaHit = true;
          console.warn('[BayesScore] CAPTCHA detected! Stopping further requests.');
          return null;
        }
        return html;
      } catch (e) {
        if (retries > 0 && !captchaHit && !abortController.signal.aborted) {
          await delay(200 + Math.random() * 300);
          return fetchHtml(url, retries - 1);
        }
        return null;
      }
    }

    // --- Fetch and parse a search page, collecting products ---
    async function fetchSearchPage(pageUrl, retries) {
      var html = await fetchHtml(pageUrl, retries);
      if (!html) {
        pagesCompleted++;
        failed++;
        consecutiveFailures++;
        broadcast({ completed: pagesCompleted, total: totalPages, newProducts: allProducts.size });
        return false;
      }
      var products = globalThis.BayesParser.parseProducts(html, hostname);
      products.forEach(function(p) {
        if (!allProducts.has(p.asin)) allProducts.set(p.asin, p);
      });
      pagesCompleted++;
      succeeded++;
      consecutiveFailures = 0;
      broadcast({ completed: pagesCompleted, total: totalPages, newProducts: allProducts.size });
      return true;
    }

    // ===================== DEPTH ANALYSIS =====================
    var tasks = [];

    if (depthAnalysis) {
      // --- Phase 1: Discovery — sample products to find categories ---
      broadcast({ phase: 'discovery', completed: 0, total: DEPTH_SAMPLE_SIZE });

      var firstPageHtml = await fetchHtml(baseUrl, MAX_RETRIES);
      if (!firstPageHtml || captchaHit || abortController.signal.aborted) {
        console.warn('[BayesScore] Depth Analysis: failed to fetch first page, falling back to normal extraction.');
        depthAnalysis = false;
      }

      var categories = [];

      if (depthAnalysis) {
        var firstPageProducts = globalThis.BayesParser.parseProducts(firstPageHtml, hostname);
        // Also add these products to our collection
        firstPageProducts.forEach(function(p) {
          if (!allProducts.has(p.asin)) allProducts.set(p.asin, p);
        });

        // Take first N non-sponsored ASINs
        var sampleAsins = [];
        for (var i = 0; i < firstPageProducts.length && sampleAsins.length < DEPTH_SAMPLE_SIZE; i++) {
          if (!firstPageProducts[i].isSponsored) {
            sampleAsins.push(firstPageProducts[i].asin);
          }
        }

        console.log('[BayesScore] Depth Analysis: sampling', sampleAsins.length, 'products for category discovery');

        // Fetch product pages in small batches to avoid rate limiting
        var categoryMap = {}; // nodeId → { nodeId, name }
        var discoveryDone = 0;
        var DISCOVERY_BATCH = 3;

        for (var di = 0; di < sampleAsins.length; di += DISCOVERY_BATCH) {
          if (abortController.signal.aborted || captchaHit) break;
          var dBatch = sampleAsins.slice(di, di + DISCOVERY_BATCH);
          await Promise.all(dBatch.map(async function(asin) {
            var productUrl = origin + '/dp/' + asin;
            var html = await fetchHtml(productUrl, MAX_RETRIES);
            discoveryDone++;
            broadcast({ phase: 'discovery', completed: discoveryDone, total: sampleAsins.length });

            if (html) {
              var nodes = globalThis.BayesParser.parseCategoryNodes(html);
              if (nodes.length > 0) {
                var leaf = nodes[nodes.length - 1]; // last = most specific
                if (!categoryMap[leaf.nodeId]) {
                  categoryMap[leaf.nodeId] = leaf;
                }
              }
            }
          }));
          if (di + DISCOVERY_BATCH < sampleAsins.length && !captchaHit) {
            await delay(300);
          }
        }

        categories = Object.keys(categoryMap).map(function(k) { return categoryMap[k]; });
        console.log('[BayesScore] Depth Analysis: discovered', categories.length, 'categories:', categories.map(function(c) { return c.name + ' (' + c.nodeId + ')'; }).join(', '));
      }

      // --- Phase 2: Detection — detect max pages per category (auto mode) ---
      if (depthAnalysis && categories.length > 0) {
        broadcast({ phase: 'detection', categories: categories.length });

        if (isAutoMode) {
          await Promise.all(categories.map(async function(cat) {
            var catUrl = origin + '/s?rh=n%3A' + cat.nodeId + '&fs=true';
            var html = await fetchHtml(catUrl, MAX_RETRIES);
            if (html) {
              cat.maxPages = globalThis.BayesParser.detectMaxPagesFromHtml(html);
            } else {
              cat.maxPages = 1;
            }
            console.log('[BayesScore] Category:', cat.name, '(node ' + cat.nodeId + '),', cat.maxPages, 'pages');
          }));
        } else {
          // Manual mode: use slider value for all categories
          categories.forEach(function(cat) { cat.maxPages = pages; });
        }

        // --- Phase 3: Build task URLs from categories ---
        for (var ci = 0; ci < categories.length; ci++) {
          var cat = categories[ci];
          var catBase = origin + '/s?rh=n%3A' + cat.nodeId + '&fs=true';
          for (var si = 0; si < sortOrders.length; si++) {
            for (var page = 1; page <= cat.maxPages; page++) {
              tasks.push(catBase + '&page=' + page + sortOrders[si]);
            }
          }
        }
      }

      // Fallback: if no categories discovered, use normal keyword search
      if (categories.length === 0) {
        console.log('[BayesScore] Depth Analysis: no categories found, falling back to normal extraction.');
        depthAnalysis = false;
      }
    }

    // ===================== NORMAL MODE (no depth analysis) =====================
    if (!depthAnalysis) {
      if (isAutoMode) {
        // Use detected pages from current page
        pages = detectMaxPages() || pages;
      }
      for (var si = 0; si < sortOrders.length; si++) {
        for (var page = 1; page <= pages; page++) {
          var sep = baseUrl.indexOf('?') !== -1 ? '&' : '?';
          tasks.push(baseUrl + sep + 'page=' + page + sortOrders[si]);
        }
      }
    }

    // ===================== FETCH ALL PAGES =====================
    totalPages = tasks.length;
    pagesCompleted = 0;
    succeeded = 0;
    failed = 0;
    consecutiveFailures = 0;
    broadcast({ completed: 0, total: totalPages, newProducts: allProducts.size });

    for (var bi = 0; bi < tasks.length; bi += BATCH_SIZE) {
      if (abortController.signal.aborted || captchaHit) break;

      // Adaptive backoff: slow down when seeing consecutive failures
      var currentDelay = BATCH_DELAY;
      if (consecutiveFailures >= 10) {
        currentDelay = 2000;
        console.warn('[BayesScore] Heavy rate limiting detected, slowing to 2s between batches');
      } else if (consecutiveFailures >= 5) {
        currentDelay = 1000;
      }

      var batch = tasks.slice(bi, bi + BATCH_SIZE);
      await Promise.all(batch.map(function(url) { return fetchSearchPage(url, MAX_RETRIES); }));
      if (bi + BATCH_SIZE < tasks.length && !captchaHit) {
        await delay(currentDelay);
      }
    }

    var elapsed = Date.now() - startTime;
    var products = Array.from(allProducts.values());

    // --- Deduplicate color variants, then filter and score ---
    var deduped = deduplicateVariants(products);
    var filtered = baseFilter(deduped, filterSponsored, minReviews, minPrice, maxPrice);
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

    var resultId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    var storageKey = 'results_' + resultId;

    // Clean old results BEFORE writing new one to free space
    cleanOldResults(storageKey, function() {
      var saveObj = {};
      saveObj[storageKey] = data;
      saveObj['lastResultId'] = resultId;
      chrome.storage.local.set(saveObj, function() {
        if (chrome.runtime.lastError) {
          console.error('[BayesScore] Storage write failed:', chrome.runtime.lastError.message);
        }
        console.log('[BayesScore] Data saved to storage (' + storageKey + '), opening results...');
        chrome.runtime.sendMessage({ action: 'extractionComplete', data: data }).catch(function() {});
        chrome.runtime.sendMessage({ action: 'openResults', resultId: resultId });
      });
    });

    abortController = null;
  }

  function cleanOldResults(keepKey, callback) {
    chrome.storage.local.get(null, function(all) {
      var toRemove = [];
      // Remove legacy lastResults key (no longer needed)
      if (all.lastResults) toRemove.push('lastResults');

      var resultKeys = Object.keys(all).filter(function(k) {
        return k.indexOf('results_') === 0 && k !== keepKey;
      });
      // Keep only the 3 most recent results
      if (resultKeys.length > 3) {
        resultKeys.sort();
        toRemove = toRemove.concat(resultKeys.slice(0, resultKeys.length - 3));
      }

      if (toRemove.length > 0) {
        chrome.storage.local.remove(toRemove, function() { callback(); });
      } else {
        callback();
      }
    });
  }

  function broadcast(progress) {
    chrome.runtime.sendMessage({ action: 'progress', progress: progress }).catch(function() {});
  }

  // ===================== VARIANT DEDUPLICATION =====================

  function deduplicateVariants(products) {
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

    products.forEach(function(p) {
      if (p.siblingAsins && p.siblingAsins.length > 0) {
        p.siblingAsins.forEach(function(sib) { union(p.asin, sib); });
      }
    });

    var groups = {};
    products.forEach(function(p) {
      var root = find(p.asin);
      if (!groups[root]) groups[root] = [];
      groups[root].push(p);
    });

    var result = [];
    Object.keys(groups).forEach(function(root) {
      var group = groups[root];
      if (group.length === 1) { result.push(group[0]); return; }
      group.sort(function(a, b) {
        if (a.price > 0 && b.price > 0) return a.price - b.price;
        if (a.price > 0) return -1;
        if (b.price > 0) return 1;
        return 0;
      });
      result.push(group[0]);
    });

    return result;
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
      case 'quality':  return scoreTrueQuality(filtered);
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


  // --- Mode 5: True Quality (anti-herd, rewards genuine quality over popularity) ---
  function scoreTrueQuality(filtered) {
    if (filtered.length === 0) return [];

    var totalWR = 0, totalR = 0;
    filtered.forEach(function(p) { totalWR += p.rating * p.reviewCount; totalR += p.reviewCount; });
    var C = totalR > 0 ? totalWR / totalR : 0;

    var counts = filtered.map(function(p) { return p.reviewCount; }).sort(function(a, b) { return a - b; });
    var m = Math.max(counts[Math.floor(counts.length * 0.25)] || 1, 50);
    var satCap = Math.max(counts[Math.floor(counts.length * 0.75)] || 100, 100);

    filtered.forEach(function(p) {
      var v = p.reviewCount;
      var R = p.rating;

      var effV = v <= satCap ? v : satCap + Math.log10(1 + v - satCap) * satCap * 0.1;

      p._bayesRaw = (effV / (effV + m)) * R + (m / (effV + m)) * C;
      p.confidence = Math.round((effV / (effV + m)) * 100);

      var mult = 1.0;
      if (p.isSponsored) mult *= 0.88;
      if (p.discount > 50) mult *= 0.92;
      else if (p.discount > 30) mult *= 0.96;
      if (p.boughtCount > 0 && v > 0) {
        var buyRatio = Math.min(p.boughtCount / v, 2);
        mult *= 1 + 0.05 * buyRatio;
      }

      p.bayesScore = Math.round(p._bayesRaw * mult * 1000) / 1000;
    });

    return finalize(filtered);
  }

})();
