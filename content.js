(function() {
  'use strict';
  if (window.__bayesScoreInjected) return;
  window.__bayesScoreInjected = true;

  var abortController = null;

  var SORT_ORDERS = ['', '&s=review-rank', '&s=price-asc-rank', '&s=price-desc-rank', '&s=date-desc-rank'];
  var DEPTH_SAMPLE_SIZE = 10;
  var DEPTH_PAGE_CAP = 40; // Cap pages per category in depth analysis (keyword+category filtering keeps relevance >99%)

  var prefetchedCategories = null;
  var prefetchInProgress = false;

  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (msg.action === 'triggerExtract') startExtraction(msg.options || {});
    if (msg.action === 'detectPages') {
      sendResponse({ pages: detectMaxPages() });
      // Auto-start prefetch when popup opens (discovery runs in background)
      if (!prefetchedCategories && !prefetchInProgress) prefetchDiscovery();
    }
  });

  async function prefetchDiscovery() {
    prefetchInProgress = true;
    try {
      var origin = window.location.origin;
      var hostname = window.location.hostname;
      var searchKeyword = '';
      try { searchKeyword = (new URL(window.location.href)).searchParams.get('k') || ''; } catch(e) {}

      // Read ASINs from DOM
      var sampleAsins = [];
      var domResults = document.querySelectorAll('[data-component-type="s-search-result"]');
      for (var i = 0; i < domResults.length && sampleAsins.length < DEPTH_SAMPLE_SIZE; i++) {
        var asin = domResults[i].getAttribute('data-asin');
        if (!asin || asin.length !== 10) continue;
        var sponsored = (domResults[i].textContent || '').indexOf('Patrocinado') !== -1
          || (domResults[i].textContent || '').indexOf('Sponsored') !== -1;
        if (!sponsored) sampleAsins.push(asin);
      }
      if (sampleAsins.length === 0) { prefetchInProgress = false; return; }

      // Fetch product pages for category discovery
      var categoryMap = {};
      var trailMap = {};
      var fetchOpts = { credentials: 'include', headers: { 'Accept': 'text/html' } };

      var htmls = await Promise.all(sampleAsins.map(function(asin) {
        return fetch(origin + '/dp/' + asin, fetchOpts).then(function(r) {
          var reader = r.body.getReader();
          var decoder = new TextDecoder();
          var parts = [];
          var prevTail = '';
          return (function read() {
            return reader.read().then(function(chunk) {
              if (chunk.done) return parts.join('');
              var decoded = decoder.decode(chunk.value, { stream: true });
              parts.push(decoded);
              var boundary = prevTail.substring(prevTail.length - 22) + decoded;
              if (boundary.indexOf('wayfinding-breadcrumbs') !== -1) { reader.cancel(); return parts.join(''); }
              prevTail = decoded;
              return read();
            });
          })();
        }).catch(function() { return null; });
      }));

      htmls.forEach(function(html) {
        if (!html) return;
        var nodes = globalThis.BayesParser.parseCategoryNodes(html);
        if (nodes.length > 0) {
          var leaf = nodes[nodes.length - 1];
          if (!categoryMap[leaf.nodeId]) {
            categoryMap[leaf.nodeId] = leaf;
            trailMap[leaf.nodeId] = nodes.slice(0, -1).map(function(n) { return n.nodeId; });
          }
        }
      });

      // Parent-child dedup
      var leafIds = Object.keys(categoryMap);
      var ancestorsToRemove = {};
      leafIds.forEach(function(id) {
        (trailMap[id] || []).forEach(function(anc) { if (categoryMap[anc]) ancestorsToRemove[anc] = true; });
      });
      Object.keys(ancestorsToRemove).forEach(function(id) { delete categoryMap[id]; });

      // Also prefetch detection (maxPages + product harvest) for each category
      var detectedCats = Object.values(categoryMap);
      if (detectedCats.length > 0 && searchKeyword) {
        await Promise.all(detectedCats.map(function(cat) {
          var detectUrl = origin + '/gp/aw/s?k=' + encodeURIComponent(searchKeyword) + '&rh=n%3A' + cat.nodeId;
          return fetch(detectUrl, fetchOpts).then(function(r) { return r.text(); }).then(function(catHtml) {
            if (catHtml) {
              var pr = /s-pagination-item[^>]*>\s*(\d+)\s*</g;
              var mx = 0, pm;
              while ((pm = pr.exec(catHtml)) !== null) { var n = parseInt(pm[1]); if (n > mx) mx = n; }
              cat.maxPages = Math.min(mx || 1, DEPTH_PAGE_CAP);
              cat.page1Harvested = true;
              // Parse products immediately (don't hold ~1.7MB HTML in memory per category)
              cat._harvestedProducts = globalThis.BayesParser.parseProducts(catHtml, hostname);
            }
          }).catch(function() {});
        }));
      }

      prefetchedCategories = { categoryMap: categoryMap, trailMap: trailMap };
      console.log('[BayesScore] Prefetch: discovered', Object.keys(categoryMap).length, 'categories +', detectedCats.filter(function(c){return c.maxPages;}).length, 'detected while user configures');
    } catch(e) {
      console.warn('[BayesScore] Prefetch failed:', e.message);
    }
    prefetchInProgress = false;
  }

  function detectMaxPages() {
    var items = document.querySelectorAll('.s-pagination-item');
    var max = 0;
    for (var i = 0; i < items.length; i++) {
      var n = parseInt(items[i].textContent.trim().replace(/[.,\s]/g, ''), 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return max || 1;
  }

  // Use mobile web endpoint for 18% faster responses (same data, lighter server processing)
  function toMobileUrl(url) {
    return url.replace(/\/s\?/, '/gp/aw/s?');
  }

  async function startExtraction(options) {
    if (abortController) abortController.abort();
    abortController = new AbortController();
    // Clear prefetch after use (will be re-fetched on next popup open)
    var usedPrefetchData = prefetchedCategories;
    prefetchedCategories = null;

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
    // Extract search keyword for keyword+category filtering
    var searchKeyword = '';
    try { searchKeyword = (new URL(window.location.href)).searchParams.get('k') || ''; } catch(e) {}

    var sortOrders = multiQuery ? SORT_ORDERS : [''];
    var allProducts = new Map();
    var pagesCompleted = 0;
    var totalPages = 0;

    var startTime = Date.now();
    var POOL_CONCURRENCY = 60; // Concurrent pool: always keeps this many requests in flight
    var consecutiveFailures = 0;
    var MAX_RETRIES = 2;
    var succeeded = 0;
    var failed = 0;
    var captchaHit = false;

    function delay(ms) {
      return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    // --- Fetch HTML: direct text() for search pages (11% faster), stream abort for product pages ---
    async function fetchHtml(url, retries, abortMarker) {
      if (abortController.signal.aborted || captchaHit) return null;
      try {
        var r = await fetch(url, {
          signal: abortController.signal,
          credentials: 'include'
        });
        if (r.status === 503) throw new Error('HTTP 503');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var html;
        if (abortMarker) {
          // Stream abort mode: for product pages where we only need a small fraction
          var reader = r.body.getReader();
          var decoder = new TextDecoder();
          var parts = [];
          var prevTail = '';
          var totalLen = 0;
          while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;
            var decoded = decoder.decode(chunk.value, { stream: true });
            parts.push(decoded);
            totalLen += decoded.length;
            var boundary = prevTail.substring(prevTail.length - abortMarker.length) + decoded;
            if (boundary.indexOf(abortMarker) !== -1 || totalLen > 1700000) {
              reader.cancel();
              break;
            }
            prevTail = decoded;
          }
          html = parts.join('');
        } else {
          // Direct text() mode: faster for search pages (browser-native, zero JS overhead)
          html = await r.text();
        }
        if (html.length < 5000 && html.indexOf('Type the characters') !== -1) {
          captchaHit = true;
          console.warn('[BayesScore] CAPTCHA detected! Stopping further requests.');
          return null;
        }
        return html;
      } catch (e) {
        if (retries > 0 && !captchaHit && !abortController.signal.aborted) {
          var backoff = Math.min(200 * Math.pow(2, MAX_RETRIES - retries), 2000);
          await delay(backoff + Math.random() * 300);
          return fetchHtml(url, retries - 1, abortMarker);
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
      broadcast({ phase: 'discovery', completed: 0, total: DEPTH_SAMPLE_SIZE });

      var categoryMap = {};
      var trailMap = {};
      var usedPrefetch = false;

      // --- Try prefetched categories first (saves ~1.7s) ---
      if (usedPrefetchData && Object.keys(usedPrefetchData.categoryMap).length > 0) {
        categoryMap = usedPrefetchData.categoryMap;
        trailMap = usedPrefetchData.trailMap;
        usedPrefetch = true;
        console.log('[BayesScore] Using prefetched categories (' + Object.keys(categoryMap).length + ' found)');
        broadcast({ phase: 'discovery', completed: DEPTH_SAMPLE_SIZE, total: DEPTH_SAMPLE_SIZE });
      }

      // --- Otherwise discover from scratch ---
      if (!usedPrefetch) {
        var sampleAsins = [];
        var domResults = document.querySelectorAll('[data-component-type="s-search-result"]');
        for (var di = 0; di < domResults.length && sampleAsins.length < DEPTH_SAMPLE_SIZE; di++) {
          var domAsin = domResults[di].getAttribute('data-asin');
          if (!domAsin || domAsin.length !== 10) continue;
          var isSpon = (domResults[di].textContent || '').indexOf('Patrocinado') !== -1
            || (domResults[di].textContent || '').indexOf('Sponsored') !== -1;
          if (!isSpon) sampleAsins.push(domAsin);
        }

        if (sampleAsins.length === 0) {
          var firstPageHtml = await fetchHtml(baseUrl, MAX_RETRIES);
          if (!firstPageHtml || captchaHit || abortController.signal.aborted) {
            depthAnalysis = false;
          } else {
            var firstPageProducts = globalThis.BayesParser.parseProducts(firstPageHtml, hostname);
            firstPageProducts.forEach(function(p) { if (!allProducts.has(p.asin)) allProducts.set(p.asin, p); });
            for (var i = 0; i < firstPageProducts.length && sampleAsins.length < DEPTH_SAMPLE_SIZE; i++) {
              if (!firstPageProducts[i].isSponsored) sampleAsins.push(firstPageProducts[i].asin);
            }
          }
        }

        if (depthAnalysis && sampleAsins.length > 0) {
          console.log('[BayesScore] Depth Analysis: sampling', sampleAsins.length, 'products for category discovery');
          var discoveryDone = 0;
          var pipelineDetectPromises = [];

          await Promise.all(sampleAsins.map(async function(asin) {
            if (abortController.signal.aborted || captchaHit) return;
            var html = await fetchHtml(origin + '/dp/' + asin, MAX_RETRIES, 'wayfinding-breadcrumbs');
            discoveryDone++;
            broadcast({ phase: 'discovery', completed: discoveryDone, total: sampleAsins.length });
            if (html) {
              var nodes = globalThis.BayesParser.parseCategoryNodes(html);
              if (nodes.length > 0) {
                var leaf = nodes[nodes.length - 1];
                if (!categoryMap[leaf.nodeId]) {
                  categoryMap[leaf.nodeId] = leaf;
                  trailMap[leaf.nodeId] = nodes.slice(0, -1).map(function(n) { return n.nodeId; });
                  // Pipeline: start detection immediately as each category is found
                  if (isAutoMode && searchKeyword) {
                    pipelineDetectPromises.push(
                      fetchHtml(toMobileUrl(origin + '/s?k=' + encodeURIComponent(searchKeyword) + '&rh=n%3A' + leaf.nodeId), MAX_RETRIES).then(function(catHtml) {
                        if (catHtml) {
                          leaf.maxPages = Math.min(globalThis.BayesParser.detectMaxPagesFromHtml(catHtml), DEPTH_PAGE_CAP);
                          var hp = globalThis.BayesParser.parseProducts(catHtml, hostname);
                          hp.forEach(function(p) { if (!allProducts.has(p.asin)) allProducts.set(p.asin, p); });
                          leaf.page1Harvested = true;
                        }
                      })
                    );
                  }
                }
              }
            }
          }));
          // Wait for any pipelined detection still in progress
          if (pipelineDetectPromises.length > 0) await Promise.all(pipelineDetectPromises);

          // Parent-child dedup
          var leafIds = Object.keys(categoryMap);
          var ancestorsToRemove = {};
          leafIds.forEach(function(id) {
            (trailMap[id] || []).forEach(function(anc) { if (categoryMap[anc]) ancestorsToRemove[anc] = true; });
          });
          Object.keys(ancestorsToRemove).forEach(function(id) {
            console.log('[BayesScore] Removing parent category "' + categoryMap[id].name + '"');
            delete categoryMap[id];
          });
        }
      }

      // --- Detection: detect max pages for each category (pipelined) ---
      var categories = Object.keys(categoryMap).map(function(k) { return categoryMap[k]; });

      if (depthAnalysis && categories.length > 0) {
        if (isAutoMode) {
          broadcast({ phase: 'detection', categories: categories.length });
          await Promise.all(categories.map(async function(cat) {
            if (cat.maxPages) {
              // Already detected by prefetch — add pre-parsed products
              if (cat._harvestedProducts) {
                cat._harvestedProducts.forEach(function(p) { if (!allProducts.has(p.asin)) allProducts.set(p.asin, p); });
                delete cat._harvestedProducts;
              }
              return;
            }
            var detectUrl = searchKeyword
              ? toMobileUrl(origin + '/s?k=' + encodeURIComponent(searchKeyword) + '&rh=n%3A' + cat.nodeId)
              : toMobileUrl(origin + '/s?rh=n%3A' + cat.nodeId + '&fs=true');
            var catHtml = await fetchHtml(detectUrl, MAX_RETRIES);
            if (catHtml) {
              cat.maxPages = Math.min(globalThis.BayesParser.detectMaxPagesFromHtml(catHtml), DEPTH_PAGE_CAP);
              var detectionProducts = globalThis.BayesParser.parseProducts(catHtml, hostname);
              detectionProducts.forEach(function(p) { if (!allProducts.has(p.asin)) allProducts.set(p.asin, p); });
              cat.page1Harvested = true;
            } else {
              cat.maxPages = 1;
            }
            console.log('[BayesScore] Category:', cat.name, '(node ' + cat.nodeId + '),', cat.maxPages, 'pages');
          }));
        } else {
          categories.forEach(function(cat) { cat.maxPages = Math.min(pages, DEPTH_PAGE_CAP); });
        }

        console.log('[BayesScore] Depth Analysis:', categories.length, 'categories:', categories.map(function(c) { return c.name + ' (' + c.nodeId + ')'; }).join(', '));

        // --- Build interleaved task URLs ---
        // Hybrid URL strategy: bbn= for pages 1-7, rh= for pages 8+ (30 results/page)
        // bbn= pages 1-6 give 60 results, page 7 gives 30 results (same as rh)
        // We include page 7 to capture ALL products Amazon offers, including those unique to bbn page 7
        var BBN_PAGES = 7;
        var kwEnc = searchKeyword ? encodeURIComponent(searchKeyword) : '';
        var maxPages = 0;
        categories.forEach(function(cat) { if (cat.maxPages > maxPages) maxPages = cat.maxPages; });
        for (var page = 1; page <= maxPages; page++) {
          for (var si = 0; si < sortOrders.length; si++) {
            for (var ci = 0; ci < categories.length; ci++) {
              var cat = categories[ci];
              if (page > cat.maxPages) continue;
              if (page === 1 && sortOrders[si] === '' && cat.page1Harvested) continue;
              var url;
              if (page <= BBN_PAGES && kwEnc) {
                // bbn= mode: 60 results/page (pages 1-7)
                url = origin + '/gp/aw/s?k=' + kwEnc + '&bbn=' + cat.nodeId + '&page=' + page + sortOrders[si];
              } else {
                // rh= mode: 30 results/page (pages 8+, or fallback without keyword)
                url = kwEnc
                  ? origin + '/gp/aw/s?k=' + kwEnc + '&rh=n%3A' + cat.nodeId + '&page=' + page + sortOrders[si]
                  : origin + '/gp/aw/s?rh=n%3A' + cat.nodeId + '&fs=true&page=' + page + sortOrders[si];
              }
              tasks.push(url);
            }
          }
        }

        // Also add keyword search pages (~36% extra unique products)
        var kwMaxPages = isAutoMode ? (detectMaxPages() || 7) : Math.min(pages, 7);
        var kwBase = toMobileUrl(baseUrl);
        for (var ksi = 0; ksi < sortOrders.length; ksi++) {
          for (var kp = 1; kp <= kwMaxPages; kp++) {
            var sep = kwBase.indexOf('?') !== -1 ? '&' : '?';
            tasks.push(kwBase + sep + 'page=' + kp + sortOrders[ksi]);
          }
        }
      }

      if (categories.length === 0) {
        console.log('[BayesScore] Depth Analysis: no categories found, falling back.');
        depthAnalysis = false;
      }
    }

    // ===================== NORMAL MODE (no depth analysis) =====================
    if (!depthAnalysis) {
      if (isAutoMode) {
        pages = detectMaxPages() || pages;
      }
      var normalBase = toMobileUrl(baseUrl);
      for (var si = 0; si < sortOrders.length; si++) {
        for (var page = 1; page <= pages; page++) {
          var sep = normalBase.indexOf('?') !== -1 ? '&' : '?';
          tasks.push(normalBase + sep + 'page=' + page + sortOrders[si]);
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

    // Concurrent pool: always keeps N requests in flight (42% faster than batch model)
    var taskIdx = 0;

    function launchNext() {
      if (taskIdx >= tasks.length || abortController.signal.aborted || captchaHit) return Promise.resolve();
      var url = tasks[taskIdx++];
      return fetchSearchPage(url, MAX_RETRIES).then(function(ok) {
        if (!ok && consecutiveFailures >= 5) {
          // Throttle: pause briefly on sustained failures
          return delay(Math.min(250 * Math.pow(2, consecutiveFailures - 3), 3000) + Math.random() * 200).then(launchNext);
        }
        return launchNext();
      });
    }

    // Launch initial pool of concurrent workers
    var poolWorkers = [];
    for (var wi = 0; wi < Math.min(POOL_CONCURRENCY, tasks.length); wi++) {
      poolWorkers.push(launchNext());
    }
    await Promise.all(poolWorkers);

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

    // Write storage and open results in parallel (results page loads while data saves)
    var saveObj = {};
    saveObj[storageKey] = data;
    saveObj['lastResultId'] = resultId;
    chrome.storage.local.set(saveObj, function() {
      if (chrome.runtime.lastError) {
        console.error('[BayesScore] Storage write failed:', chrome.runtime.lastError.message);
      }
      console.log('[BayesScore] Data saved (' + storageKey + ')');
    });
    // Open results immediately (don't wait for storage write)
    chrome.runtime.sendMessage({ action: 'extractionComplete', data: data }).catch(function() {});
    chrome.runtime.sendMessage({ action: 'openResults', resultId: resultId });
    // Clean old results in background (non-blocking)
    cleanOldResults(storageKey, function() {});

    abortController = null;
  }

  function cleanOldResults(keepKey, callback) {
    // Use getKeys() to avoid reading multi-MB result data just to get key names
    if (chrome.storage.local.getKeys) {
      chrome.storage.local.getKeys(function(keys) {
        var toRemove = [];
        if (keys.indexOf('lastResults') !== -1) toRemove.push('lastResults');
        var resultKeys = keys.filter(function(k) { return k.indexOf('results_') === 0 && k !== keepKey; });
        if (resultKeys.length > 3) {
          resultKeys.sort();
          toRemove = toRemove.concat(resultKeys.slice(0, resultKeys.length - 3));
        }
        if (toRemove.length > 0) chrome.storage.local.remove(toRemove, callback);
        else callback();
      });
    } else {
      // Fallback for older Chrome versions
      chrome.storage.local.get(null, function(all) {
        var toRemove = [];
        if (all.lastResults) toRemove.push('lastResults');
        var resultKeys = Object.keys(all).filter(function(k) { return k.indexOf('results_') === 0 && k !== keepKey; });
        if (resultKeys.length > 3) {
          resultKeys.sort();
          toRemove = toRemove.concat(resultKeys.slice(0, resultKeys.length - 3));
        }
        if (toRemove.length > 0) chrome.storage.local.remove(toRemove, callback);
        else callback();
      });
    }
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
