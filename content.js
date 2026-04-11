(function() {
  'use strict';
  if (window.__bayesScoreInjected) return;
  window.__bayesScoreInjected = true;

  var abortController = null;

  var SORT_ORDERS = ['', '&s=review-rank', '&s=review-count-rank', '&s=price-asc-rank', '&s=price-desc-rank', '&s=date-desc-rank'];
  // review-count-rank (most reviewed) complements review-rank (best rating) — measured +427 products for +80 requests
  var DEPTH_SAMPLE_SIZE = 10;
  var DEPTH_PAGE_CAP = 60; // Cap 60 measured to give +27% products (+3231 extra) for +400 requests vs cap 40

  var prefetchedCategories = null;
  var prefetchInProgress = false;
  var prefetchPromise = null;

  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (msg.action === 'triggerExtract') startExtraction(msg.options || {});
    if (msg.action === 'detectPages') {
      sendResponse({ pages: detectMaxPages() });
      if (msg.prefetch) maybeStartPrefetch();
    }
    if (msg.action === 'prefetchDiscovery') {
      maybeStartPrefetch();
      sendResponse({ ok: true, cached: !!prefetchedCategories, running: prefetchInProgress });
    }
  });

  function maybeStartPrefetch() {
    if (prefetchedCategories) return Promise.resolve(prefetchedCategories);
    if (prefetchPromise) return prefetchPromise;
    prefetchPromise = prefetchDiscovery().finally(function() {
      prefetchPromise = null;
    });
    return prefetchPromise;
  }

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
      if (sampleAsins.length === 0) return null;

      // Fetch product pages for category discovery
      var categoryMap = {};
      var trailMap = {};
      var productFetchOpts = { credentials: 'include', headers: { 'Accept': 'text/html' } };
      var searchFetchOpts = { credentials: 'include' };

      var htmls = await Promise.all(sampleAsins.map(function(asin) {
        return fetch(origin + '/dp/' + asin, productFetchOpts).then(function(r) {
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
          return fetch(detectUrl, searchFetchOpts).then(function(r) { return r.text(); }).then(function(catHtml) {
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
      return prefetchedCategories;
    } catch(e) {
      console.warn('[BayesScore] Prefetch failed:', e.message);
      return null;
    } finally {
      prefetchInProgress = false;
    }
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

  function normalizeSearchBaseUrl(rawUrl, removeSort) {
    try {
      var url = new URL(rawUrl);
      url.searchParams.delete('page');
      if (removeSort) url.searchParams.delete('s');
      return url.toString();
    } catch(e) {
      return rawUrl.split('&page=')[0].split('?page=')[0];
    }
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

    var baseUrl = normalizeSearchBaseUrl(window.location.href, multiQuery);
    var hostname = window.location.hostname;
    var origin = window.location.origin;
    // Extract search keyword for keyword+category filtering
    var searchKeyword = '';
    try { searchKeyword = (new URL(window.location.href)).searchParams.get('k') || ''; } catch(e) {}

    if (depthAnalysis && prefetchPromise) {
      try { await prefetchPromise; } catch(e) {}
    }

    // Clear prefetch after use (will be re-fetched on next popup open)
    var usedPrefetchData = depthAnalysis ? prefetchedCategories : null;
    if (depthAnalysis) prefetchedCategories = null;

    var sortOrders = multiQuery ? SORT_ORDERS : [''];
    var allProducts = new Map();
    var pagesCompleted = 0;
    var totalPages = 0;

    // --- Harvest products directly from the current DOM ---
    // The user is already on /s?k=keyword — the page is fully rendered with ~60 products.
    // Parsing the DOM gives us those products in ~8ms with zero network cost.
    // We still fetch page=1 of each sort afterwards because Amazon rotates results
    // between requests (measured 75% overlap between DOM and fresh fetch), so the
    // DOM snapshot surfaces ~10 unique "bonus" products the pool fetches would miss.
    try {
      var bodyHtml = document.body.innerHTML;
      if (bodyHtml.indexOf('data-component-type="s-search-result"') !== -1) {
        var domProducts = globalThis.BayesParser.parseProducts(bodyHtml, hostname);
        if (domProducts && domProducts.length > 0) {
          domProducts.forEach(function(p) {
            if (!allProducts.has(p.asin)) allProducts.set(p.asin, p);
          });
          console.log('[BayesScore] Harvested ' + domProducts.length + ' products from DOM');
        }
      }
    } catch (e) { /* DOM harvest is best-effort */ }

    var startTime = Date.now();
    var POOL_CONCURRENCY = 100; // Pool size: 100 gives 14% better throughput than 60 (measured via CDP: 57 vs 49 pps). Pool 150 triggers Amazon rate limiting (TTFB 400ms→700ms).
    var consecutiveFailures = 0;
    var MAX_RETRIES = 2;
    var succeeded = 0;
    var failed = 0;
    var captchaHit = false;

    function delay(ms) {
      return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    // --- Parse one JSON-streaming chunk and push its HTML if it's a product or pagination chunk ---
    // STRICT filter: only 'data-main-slot:search-result-N' chunks (real products) plus any
    // plain data-main-slot chunk containing the pagination strip (needed for page detection).
    // The other plain data-main-slot chunks are ad holders, related searches, and bottom
    // recommendation widgets that contribute 0 products but bloat the parser input.
    // Measured vs unfiltered: -32% parser input bytes, same product count.
    function pushChunkHtml(chunk, htmls) {
      var s = 0;
      while (s < chunk.length && chunk.charCodeAt(s) <= 32) s++;
      if (s >= chunk.length || chunk.charCodeAt(s) !== 91 /* '[' */) return;
      try {
        var parsed = JSON.parse(s === 0 ? chunk : chunk.substring(s));
        var name = parsed[1];
        var html = parsed[2] && parsed[2].html;
        if (!name || !html) return;
        // Individual product chunks (the 60 per page we care about)
        if (name.indexOf('data-main-slot:search-result-') === 0) {
          htmls.push(html);
        }
        // Pagination strip (only ~3KB, needed for detectMaxPagesFromHtml)
        else if (name.indexOf('data-main-slot') === 0 && html.indexOf('s-pagination-strip') !== -1) {
          htmls.push(html);
        }
      } catch (e) { /* skip malformed chunk */ }
    }

    // --- Sync parser: split a full response text by '&&&' and extract product HTML ---
    function parseSearchStream(text) {
      var chunks = text.split('&&&');
      var htmls = [];
      for (var i = 0; i < chunks.length; i++) pushChunkHtml(chunks[i], htmls);
      return htmls.join('');
    }

    // --- Blob parser: read the response as a blob and decode in one native pass ---
    // Measured: ~5% faster than stream-based parse at 100 concurrent (1493ms vs 1574ms,
    // 8-run median). Chrome decodes the whole blob internally in C++ without JS-side
    // chunk looping or TextDecoder call overhead, and blob.text() is a single native
    // decode that V8 optimizes well.
    async function parseSearchResponse(response) {
      var text = await (await response.blob()).text();
      return parseSearchStream(text);
    }

    // --- Fetch HTML: /s/query JSON POST for search pages (13.5% faster, -41% wire bytes), stream abort for product pages ---
    // /s/query returns JSON-streaming format which we parse. Measured via CDP:
    //   /gp/aw/s: 265KB wire, 937ms total
    //   /s/query: 157KB wire, 723ms total (same products ±0.2%)
    async function fetchHtml(url, retries, abortMarker) {
      if (abortController.signal.aborted || captchaHit) return null;
      // Detect: is this a search page URL (convert to /s/query POST) or product page (keep as-is)?
      var isSearchPage = !abortMarker && url.indexOf('/gp/aw/s?') !== -1;
      var fetchOpts;
      var fetchUrl = url;
      if (isSearchPage) {
        // Convert /gp/aw/s? → /s/query? and switch to POST with JSON body
        // Key findings (measured via CDP):
        //   - /s/query is -41% wire bytes vs /gp/aw/s (gzip 8.60x vs 6.12x)
        //   - "pagination" action is 5.5% faster than "query" action
        //   - Content-Type: text/plain is 17.7% faster than application/json (200-request test)
        //     Reason unclear — possibly different server validation path
        fetchUrl = url.replace('/gp/aw/s?', '/s/query?');
        fetchOpts = {
          signal: abortController.signal,
          method: 'POST',
          credentials: 'omit',
          headers: {
            'content-type': 'text/plain',
            'accept': '*/*'
          },
          body: '{"customer-action":"pagination"}'
        };
      } else {
        fetchOpts = { signal: abortController.signal, credentials: 'omit' };
      }
      try {
        var r = await fetch(fetchUrl, fetchOpts);
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
        } else if (isSearchPage) {
          // Blob + parse: decode response in one native pass and extract product chunks
          html = await parseSearchResponse(r);
        } else {
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

        // Related search keyword expansion — measured +1800 products at 20 prods/req (best ratio)
        // Amazon's text-reformulation widget shows brand/type variants (e.g. "audifonos bluetooth sony")
        // Each variant surfaces products not found via category discovery alone
        var RELATED_KEYWORD_CAP = 6; // Max related keywords to add
        var RELATED_PAGES_PER_KEYWORD = 5; // Pages per keyword (first 5 pages have highest yield)
        var RELATED_SORTS_PER_KEYWORD = 3; // Only use top 3 sorts for related (default, reviews, price-asc)
        var relatedSorts = sortOrders.length >= 3 ? sortOrders.slice(0, 3) : sortOrders;

        // Tokenize a keyword: lowercase, strip diacritics, drop stopwords and short tokens.
        // Amazon's text-reformulation-widget returns a mix of: (1) strict refinements
        // ("pasta dental colgate"), (2) sibling products ("plancha de vapor portatil"
        // when original is "plancha de vapor vertical"), and (3) cross-sells ("shampoo"
        // when original is "pasta dental"). We only want (1). The filter requires that
        // ALL meaningful tokens of the original appear in the related keyword — this is
        // the definition of a refinement that specializes the query. Siblings and
        // cross-sells drop out because at least one original token is missing.
        var STOPWORDS = { 'de':1,'la':1,'el':1,'los':1,'las':1,'para':1,'con':1,'sin':1,
          'en':1,'del':1,'un':1,'una':1,'mi':1,'tu':1,'es':1,'por':1,'al':1,'lo':1,
          'the':1,'of':1,'for':1,'with':1,'without':1,'in':1,'and':1,'or':1,'from':1,
          'to':1,'on':1,'at':1,'by':1,'is':1,'it':1 };
        function tokenizeKw(kw) {
          if (!kw) return [];
          return kw.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
            .split(/[\s\-,+]+/)
            // Min length 2 to keep legitimate short tokens like "tv", "pc", "4k", "5g";
            // the STOPWORDS list catches 2-char noise (de, la, el, en, al, etc.)
            .filter(function(t) { return t.length >= 2 && !STOPWORDS[t]; });
        }
        var originalTokens = tokenizeKw(searchKeyword);
        function isRefinementOfOriginal(rk) {
          if (originalTokens.length === 0) return true; // no tokens to compare — keep all
          var relTokens = tokenizeKw(rk);
          // Every original token must appear in the related keyword's token set
          for (var i = 0; i < originalTokens.length; i++) {
            if (relTokens.indexOf(originalTokens[i]) === -1) return false;
          }
          return true;
        }

        var reformWidget = document.querySelector('[data-component-type="text-reformulation-widget"]');
        if (reformWidget) {
          var relatedKeywords = [];
          var droppedCrossSell = [];
          var seenKeywords = {};
          reformWidget.querySelectorAll('a').forEach(function(a) {
            var href = a.getAttribute('href') || '';
            var kwMatch = href.match(/[?&]k=([^&]+)/);
            if (kwMatch) {
              try {
                var rk = decodeURIComponent(kwMatch[1]);
                // Skip if same as original keyword or already seen
                if (rk && rk !== searchKeyword && !seenKeywords[rk]) {
                  seenKeywords[rk] = true;
                  // Only keep strict refinements (contain ALL original tokens)
                  if (isRefinementOfOriginal(rk)) {
                    if (relatedKeywords.length < RELATED_KEYWORD_CAP) relatedKeywords.push(rk);
                  } else {
                    droppedCrossSell.push(rk);
                  }
                }
              } catch(e) {}
            }
          });
          if (droppedCrossSell.length > 0) {
            console.log('[BayesScore] Dropped ' + droppedCrossSell.length + ' non-refinement related keywords (missing tokens from "' + searchKeyword + '"):', droppedCrossSell.join(', '));
          }
          if (relatedKeywords.length > 0) {
            console.log('[BayesScore] Related keywords:', relatedKeywords.join(', '));
            relatedKeywords.forEach(function(rk) {
              var rkEnc = encodeURIComponent(rk);
              for (var rsi = 0; rsi < relatedSorts.length; rsi++) {
                for (var rp = 1; rp <= RELATED_PAGES_PER_KEYWORD; rp++) {
                  tasks.push(origin + '/gp/aw/s?k=' + rkEnc + '&page=' + rp + relatedSorts[rsi]);
                }
              }
            });
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
    var preview = scoreBayesianPreview(filtered);
    var query = (new URL(window.location.href)).searchParams.get('k') || '';

    console.log('[BayesScore] Done:', succeeded + '/' + totalPages, 'pages OK,', failed, 'failed,', captchaHit ? 'CAPTCHA!' : 'no CAPTCHA,', products.length, 'raw,', filtered.length, 'filtered,', preview.count, 'scored in', (elapsed/1000).toFixed(1) + 's');

    // --- Store raw filtered products + compact preview for popup/results handoff ---
    var data = {
      rawProducts: filtered,
      scoredPreview: preview.scoredPreview,
      scoredCount: preview.count,
      variantDeduped: true,
      stats: { pagesSucceeded: succeeded, pagesFailed: failed, totalPages: totalPages, elapsedMs: elapsed, captchaHit: captchaHit },
      scoringMode: 'bayesian',
      query: query,
      url: window.location.href,
      timestamp: Date.now()
    };

    data.summary = preview.summary;

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
    var counts = [];
    filtered.forEach(function(p) {
      totalWR += p.rating * p.reviewCount;
      totalR += p.reviewCount;
      counts.push(p.reviewCount);
    });
    var C = totalR > 0 ? totalWR / totalR : 0;
    var m = Math.max(selectNumber(counts, Math.floor(counts.length * 0.25)) || 1, 50);
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

  function selectNumber(values, k) {
    if (values.length === 0) return 0;
    var left = 0;
    var right = values.length - 1;
    while (left <= right) {
      var pivot = values[Math.floor((left + right) / 2)];
      var lt = left;
      var i = left;
      var gt = right;
      while (i <= gt) {
        if (values[i] < pivot) {
          swapNumbers(values, lt, i);
          lt++;
          i++;
        } else if (values[i] > pivot) {
          swapNumbers(values, i, gt);
          gt--;
        } else {
          i++;
        }
      }
      if (k < lt) right = lt - 1;
      else if (k > gt) left = gt + 1;
      else return pivot;
    }
    return values[k] || 0;
  }

  function swapNumbers(values, a, b) {
    var tmp = values[a];
    values[a] = values[b];
    values[b] = tmp;
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

  function scoreBayesianPreview(filtered) {
    if (filtered.length === 0) {
      return { count: 0, scoredPreview: [], summary: { maxScore: 0, avgScore: 0 } };
    }

    var totalWR = 0, totalR = 0;
    var counts = [];
    filtered.forEach(function(p) {
      totalWR += p.rating * p.reviewCount;
      totalR += p.reviewCount;
      counts.push(p.reviewCount);
    });
    var C = totalR > 0 ? totalWR / totalR : 0;
    var m = Math.max(selectNumber(counts, Math.floor(counts.length * 0.25)) || 1, 50);

    var top = [];
    var avgSum = 0;
    filtered.forEach(function(p) {
      var v = p.reviewCount;
      var bayesRaw = (v / (v + m)) * p.rating + (m / (v + m)) * C;
      var entry = {
        product: p,
        bayesScore: Math.round(bayesRaw * 1000) / 1000,
        confidence: Math.round((v / (v + m)) * 100)
      };
      avgSum += entry.bayesScore;

      if (top.length < 5) {
        top.push(entry);
        top.sort(comparePreviewEntries);
      } else if (comparePreviewEntries(entry, top[top.length - 1]) < 0) {
        top[top.length - 1] = entry;
        top.sort(comparePreviewEntries);
      }
    });

    var scoredPreview = top.map(function(entry, i) {
      var p = Object.assign({}, entry.product);
      p.bayesScore = entry.bayesScore;
      p.confidence = entry.confidence;
      p.rank = i + 1;
      return p;
    });

    return {
      count: filtered.length,
      scoredPreview: scoredPreview,
      summary: {
        maxScore: scoredPreview.length > 0 ? scoredPreview[0].bayesScore : 0,
        avgScore: Math.round((avgSum / filtered.length) * 100) / 100
      }
    };
  }

  function comparePreviewEntries(a, b) {
    var diff = b.bayesScore - a.bayesScore;
    if (diff !== 0) return diff;
    return b.product.reviewCount - a.product.reviewCount;
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
    var revCounts = candidates.map(function(p) { return p.reviewCount; });
    var median = selectNumber(revCounts, Math.floor(revCounts.length / 2)) || 1;
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

    var counts = filtered.map(function(p) { return p.reviewCount; });
    var m = Math.max(selectNumber(counts.slice(), Math.floor(counts.length * 0.25)) || 1, 50);
    var satCap = Math.max(selectNumber(counts, Math.floor(counts.length * 0.75)) || 100, 100);

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
