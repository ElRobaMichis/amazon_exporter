// ============================================================
// Multi-page Parallel Fetcher
// Leverages HTTP/3 QUIC — no 6-connection limit
// Supports: single-query, multi-query (5 sort orders)
// ============================================================

const SORT_ORDERS = [
  '',                          // relevance (default)
  '&s=review-rank',            // avg customer review
  '&s=price-asc-rank',         // price low to high
  '&s=price-desc-rank',        // price high to low
  '&s=date-desc-rank'          // newest arrivals
];

const ELECTRONICS_FILTER = '&rh=n%3A172282';

/**
 * Fetch multiple pages of Amazon search results in parallel.
 *
 * @param {string} baseUrl - The search URL (page 1)
 * @param {Object} options
 * @param {number}  [options.pages=5] - Number of pages per query
 * @param {boolean} [options.multiQuery=false] - Use 5 sort orders
 * @param {boolean} [options.electronicsFilter=false] - Add electronics dept filter
 * @param {Function} [options.onPageDone] - Callback(products[], pageNum, total)
 * @param {Function} [options.onError] - Callback(error, pageNum)
 * @param {AbortSignal} [options.signal] - AbortController signal
 * @returns {Promise<{products: Array, stats: Object}>}
 */
async function fetchPages(baseUrl, options = {}) {
  const {
    pages = 5,
    multiQuery = false,
    electronicsFilter = false,
    onPageDone = null,
    onError = null,
    signal = null
  } = options;

  // Normalize base URL
  let url = baseUrl.split('&page=')[0].split('?page=')[0];
  if (electronicsFilter && !url.includes('rh=n')) {
    url += (url.includes('?') ? '' : '?') + ELECTRONICS_FILTER;
  }

  const sortOrders = multiQuery ? SORT_ORDERS : [''];
  const allProducts = new Map(); // ASIN → product (dedup)
  let pagesCompleted = 0;
  const totalPages = pages * sortOrders.length;
  const startTime = Date.now();

  // Build all fetch tasks
  const tasks = [];
  for (const sort of sortOrders) {
    for (let page = 1; page <= pages; page++) {
      const pageUrl = url + (url.includes('?') ? '&' : '?') + `page=${page}${sort}`;
      tasks.push({ pageUrl, page, sort });
    }
  }

  // Execute all in parallel (H3/QUIC — no connection limit)
  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      if (signal?.aborted) throw new Error('Aborted');

      try {
        const response = await fetch(task.pageUrl, {
          signal,
          credentials: 'include',
          headers: {
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9,es;q=0.8'
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const html = await response.text();

        // CAPTCHA detection
        if (html.length < 5000 && html.includes('Type the characters you see')) {
          throw new Error('CAPTCHA detected');
        }

        // Parse with Approach K
        const products = globalThis.BayesParser.parseProducts(html);

        // Dedup by ASIN
        let newCount = 0;
        for (const p of products) {
          if (!allProducts.has(p.asin)) {
            allProducts.set(p.asin, p);
            newCount++;
          }
        }

        pagesCompleted++;
        if (onPageDone) {
          onPageDone(products, pagesCompleted, totalPages, newCount);
        }

        return { success: true, count: products.length, newCount };
      } catch (err) {
        if (onError) onError(err, task.page);
        throw err;
      }
    })
  );

  const elapsed = Date.now() - startTime;
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  const products = Array.from(allProducts.values());

  return {
    products,
    stats: {
      totalPages,
      pagesSucceeded: succeeded,
      pagesFailed: failed,
      uniqueProducts: products.length,
      elapsedMs: elapsed,
      pagesPerSecond: Math.round((succeeded / (elapsed / 1000)) * 10) / 10,
      productsPerSecond: Math.round((products.length / (elapsed / 1000)) * 10) / 10,
      multiQuery,
      electronicsFilter
    }
  };
}

/**
 * Detect the Amazon domain and build a clean search URL.
 */
function buildSearchUrl(currentUrl, query) {
  const url = new URL(currentUrl);
  const domain = url.hostname; // e.g., www.amazon.com.mx
  return `https://${domain}/s?k=${encodeURIComponent(query)}`;
}

/**
 * Extract the current search query from an Amazon URL.
 */
function extractSearchQuery(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('k') || '';
  } catch {
    return '';
  }
}

// Export
if (typeof globalThis !== 'undefined') {
  globalThis.BayesFetcher = { fetchPages, buildSearchUrl, extractSearchQuery };
}
