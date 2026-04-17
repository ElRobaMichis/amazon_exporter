// ============================================================
// Approach K Parser — Pre-trim + Split + Pre-compiled Regex
// Benchmarked: 0.46ms/page (27x faster than DOMParser)
// Multi-language: EN, ES, DE, FR, IT, PT, NL, JP, PL, SE, AR
// ============================================================

(function() {
if (globalThis.BayesParser) return; // already loaded

const RE_ASIN    = /data-asin="([A-Z0-9]{10})"/;
const RE_TITLE   = /<h2[^>]*aria-label="([^"]+)"/;
const RE_STAR    = /a-star-mini-(\d)(?:-(\d))?/;
// Exact rating from aria text: "4.6 out of 5 stars", "4.6 de 5 estrellas", "4,6 von 5 Sternen", "5 out of 5", etc.
// Handles both decimal (4.6, 4,6) and integer (5, 4) ratings
const RE_RATING_EXACT = /a-icon-alt[^>]*>(\d(?:[.,]\d)?)\s/;

// Multi-language review count:
// EN: "55,229 ratings"
// ES: "25,887 clasificaciones"
// DE: "55.229 Sternebewertungen"
// FR: "55 229 évaluations"
// IT: "55.229 voti"
// PT: "55.229 classificações"
// NL: "55.229 beoordelingen"
// JP: "55,229個の評価"
// PL: "55 229 ocen"
// SE: "55 229 betyg"
// AR: "55,229 تقييم"
const RE_REVIEWS = /aria-label="([\d,.\s]+)\s*(?:ratings|clasificaciones|Sternebewertungen|évaluations|voti|classificações|beoordelingen|個の評価|ocen|betyg|تقييم)/;

const RE_PRICE   = /a-price[^"]*"[\s\S]{0,500}?a-offscreen">([\s\S]*?)<\/span>/;
const RE_LIST    = /a-text-price[\s\S]{0,300}?a-offscreen">([\s\S]*?)<\/span>/;

// Multi-language "bought in past month":
// EN: "5K+ bought in past month"
// ES: "500+ comprados el mes pasado"
// DE: "500+ Mal im letzten Monat gekauft"
// FR: "500+ achetés le mois dernier"
// IT: "500+ acquistati nell'ultimo mese"
// PT: "500+ comprados no mês passado"
// NL: "500+ gekocht in de afgelopen maand"
// JP: "先月は500点以上購入"
const RE_BOUGHT  = /([\d.]+)(K?)\+?\s*(?:bought in past|comprados? el mes|Mal im letzten Monat|achetés? le mois|acquistati nell|comprados? no m[êe]s|gekocht in de afgelopen|先月は|点以上購入)/i;

const RE_BADGE   = /a-badge-text[^>]*>([^<]+)/;
const RE_DP_HREF = /href="(\/[^"]*\/dp\/([A-Z0-9]{10})[^"]*)"/g;
const RE_IMG     = /src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/;
const SPLITTER   = 'data-component-type="s-search-result"';
const BLOCK_CAP  = 16000; // 16KB: mobile Amazon blocks need ~14KB after attribute stripping (desktop ~5KB)

// Multi-language sponsored keywords
const SPONSORED_KEYWORDS = [
  'Sponsored', 'Patrocinado', 'Gesponsert', 'Sponsorisé',
  'Sponsorizzato', 'Gesponsord', 'スポンサー',
  'Sponsorowane', 'Sponsrad', 'برعاية'
];

/**
 * Parse Amazon search HTML into product objects.
 * Uses pre-trim to discard ~55% of wasted HTML (header/footer),
 * then splits by result markers and applies pre-compiled regex.
 *
 * @param {string} html - Full HTML of an Amazon search page
 * @returns {Array<Object>} Array of product objects
 */
function parseProducts(html, domain) {
  // Step 1: Pre-trim — only keep the results section
  const firstResult = html.indexOf(SPLITTER);
  if (firstResult === -1) return [];

  const trimStart = Math.max(0, firstResult - 250);
  let trimEnd = html.indexOf('s-pagination-strip', firstResult);
  if (trimEnd === -1) trimEnd = html.indexOf('puis-footer', firstResult);
  if (trimEnd === -1) trimEnd = html.length;
  trimEnd = Math.min(trimEnd + 500, html.length);

  var trimmed = html.substring(trimStart, trimEnd);

  // Step 1b: Strip mobile-heavy data attributes that bloat blocks beyond BLOCK_CAP.
  // Mobile Amazon wraps each product in ~8KB of data-payload JSON and data-csa-* tracking
  // attributes that push title/rating/price past the 12.8KB cap. Stripping is safe (parser
  // never reads these attributes) and a no-op on desktop HTML where they don't exist.
  trimmed = trimmed.replace(/data-payload="[^"]*"/g, '').replace(/data-csa-[a-z-]*="[^"]*"/g, '');

  // Step 2: Split by result marker — creates one block per product
  const blocks = trimmed.split(SPLITTER);
  const products = [];

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].substring(0, BLOCK_CAP);
    const prevTail = blocks[i - 1].substring(blocks[i - 1].length - 250);

    // ASIN
    const am = RE_ASIN.exec(prevTail);
    if (!am) continue;
    const asin = am[1];

    // Title
    const tm = RE_TITLE.exec(block);
    if (!tm) continue;
    const title = decodeHTMLEntities(tm[1]);

    // Rating — prefer exact value from a-icon-alt ("4.6 de 5 estrellas"), fall back to CSS class
    const exactMatch = RE_RATING_EXACT.exec(block);
    let rating;
    if (exactMatch) {
      rating = parseFloat(exactMatch[1].replace(',', '.'));
    } else {
      const sm = RE_STAR.exec(block);
      rating = sm ? parseFloat(sm[1] + '.' + (sm[2] || '0')) : 0;
    }

    // Review count (multi-language)
    const rvm = RE_REVIEWS.exec(block);
    const reviewCount = rvm ? parseInt(rvm[1].replace(/[,.\s]/g, '')) : 0;

    // Price
    const pm = RE_PRICE.exec(block);
    const priceRaw = pm ? pm[1] : '';
    const price = parsePrice(priceRaw);
    const currency = extractCurrency(priceRaw, domain);

    // List price
    const lm = RE_LIST.exec(block);
    const listPrice = lm ? parsePrice(lm[1]) : 0;

    // Bought count (multi-language)
    const bm = RE_BOUGHT.exec(block);
    let boughtCount = 0;
    if (bm) {
      boughtCount = bm[2] === 'K'
        ? parseFloat(bm[1]) * 1000
        : parseInt(bm[1]);
    }

    // Badge
    const bdm = RE_BADGE.exec(block);
    const badge = bdm ? bdm[1].trim() : '';

    // Sponsored detection (multi-language)
    const isSponsored = SPONSORED_KEYWORDS.some(kw => block.indexOf(kw) !== -1);

    // Product URL + variant/sibling ASINs from color swatch links
    const siblingAsins = [];
    let productUrl = `/dp/${asin}`;
    let hrefMatch;
    RE_DP_HREF.lastIndex = 0;
    while ((hrefMatch = RE_DP_HREF.exec(block)) !== null) {
      if (productUrl === `/dp/${asin}`) productUrl = hrefMatch[1];
      const linkAsin = hrefMatch[2];
      if (linkAsin !== asin && siblingAsins.indexOf(linkAsin) === -1) siblingAsins.push(linkAsin);
    }

    // Image
    const imgMatch = RE_IMG.exec(block);
    const imageUrl = imgMatch ? imgMatch[1] : '';

    products.push({
      asin,
      title,
      rating,
      reviewCount,
      price,
      listPrice,
      currency,
      boughtCount,
      badge,
      isSponsored,
      productUrl,
      imageUrl,
      discount: listPrice > 0 && listPrice >= price ? Math.round((1 - price / listPrice) * 100) : 0,
      siblingAsins
    });
  }

  return products;
}

/**
 * Parse price string handling both US (1,234.56) and EU (1.234,56) formats.
 */
function parsePrice(priceStr) {
  if (!priceStr) return 0;
  const cleaned = priceStr.replace(/[^\d,.\s]/g, '').trim();
  if (!cleaned) return 0;

  // Detect format: if comma is after last dot → EU format (1.234,56)
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  if (lastComma > lastDot) {
    // EU format: dots as thousands, comma as decimal
    return parseFloat(cleaned.replace(/\./g, '').replace(',', '.')) || 0;
  }
  // US format or no decimals
  return parseFloat(cleaned.replace(/,/g, '')) || 0;
}

function decodeHTMLEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

// Domain-to-currency mapping for Amazon sites using $
const DOMAIN_CURRENCY = {
  'amazon.com.mx': 'MXN',
  'amazon.ca': 'CAD',
  'amazon.com.au': 'AUD',
  'amazon.com.br': 'BRL',
  'amazon.sg': 'SGD',
  'amazon.co.uk': 'GBP',
  'amazon.de': 'EUR',
  'amazon.fr': 'EUR',
  'amazon.it': 'EUR',
  'amazon.es': 'EUR',
  'amazon.nl': 'EUR',
  'amazon.co.jp': 'JPY',
  'amazon.in': 'INR',
  'amazon.pl': 'PLN',
  'amazon.se': 'SEK',
  'amazon.sa': 'SAR',
  'amazon.ae': 'AED',
  'amazon.com': 'USD'
};

function extractCurrency(priceStr, domain) {
  if (!priceStr) return domainFallback(domain);
  const s = priceStr.trim();
  // Check specific markers first
  if (s.includes('£')) return 'GBP';
  if (s.includes('€')) return 'EUR';
  if (s.includes('¥') || s.includes('￥')) return 'JPY';
  if (s.includes('₹')) return 'INR';
  if (s.includes('R$')) return 'BRL';
  if (s.includes('CDN$') || s.includes('CDN')) return 'CAD';
  if (s.includes('A$') || s.includes('AU')) return 'AUD';
  if (s.includes('zł') || s.includes('PLN')) return 'PLN';
  if (s.includes('kr') || s.includes('SEK')) return 'SEK';
  if (s.includes('ر.س') || s.includes('SAR')) return 'SAR';
  if (s.includes('د.إ') || s.includes('AED')) return 'AED';
  // $ can be USD, MXN, CAD, AUD — detect by domain
  if (s.includes('$')) {
    return domainFallback(domain);
  }
  return domainFallback(domain);
}

function domainFallback(domain) {
  if (!domain) return 'USD';
  for (const [d, c] of Object.entries(DOMAIN_CURRENCY)) {
    if (domain.includes(d)) return c;
  }
  return 'USD';
}

/**
 * Parse category breadcrumb node IDs from an Amazon product page.
 * Extracts node IDs and category names from the wayfinding breadcrumb.
 *
 * @param {string} html - Full HTML of an Amazon product page (/dp/ASIN)
 * @returns {Array<{nodeId: string, name: string}>} Array of category nodes (last = leaf)
 */
function parseCategoryNodes(html) {
  // Desktop uses wayfinding-breadcrumbs_feature_div; mobile uses breadcrumb_feature_div
  var start = html.indexOf('wayfinding-breadcrumbs_feature_div');
  if (start === -1) start = html.indexOf('breadcrumb_feature_div');
  if (start === -1) return [];

  var section = html.substring(start, start + 5000); // 5KB: mobile breadcrumb HTML is more verbose than desktop
  var re = /href="[^"]*node=(\d+)[^"]*"[^>]*>([^<]+)/g;
  var nodes = [];
  var seen = {};
  var m;
  while ((m = re.exec(section)) !== null) {
    var nodeId = m[1];
    var name = m[2].trim();
    if (!seen[nodeId]) {
      seen[nodeId] = true;
      nodes.push({ nodeId: nodeId, name: name });
    }
  }
  return nodes;
}

/**
 * Detect max pages from a fetched search results HTML string.
 * Works on raw HTML (no DOM access needed).
 *
 * @param {string} html - Full HTML of an Amazon search results page
 * @returns {number} Max page number found, or 1
 */
function detectMaxPagesFromHtml(html) {
  // Desktop: numbered s-pagination-item elements
  var re = /s-pagination-item[^>]*>\s*(\d+)\s*</g;
  var max = 0;
  var m;
  while ((m = re.exec(html)) !== null) {
    var n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  if (max > 0) return max;
  // Mobile: progressive-scroll data attribute contains "maxPages":"N"
  // Value is HTML-entity-encoded (&quot;maxPages&quot;:&quot;6&quot;), so use a loose match
  var mp = html.match(/maxPages[^0-9]{1,15}(\d+)/);
  if (mp) max = parseInt(mp[1], 10);
  if (max > 0) return max;
  // Mobile fallback: highest page= value in pagination links
  var pageRe = /[?&]page=(\d+)/g;
  while ((m = pageRe.exec(html)) !== null) {
    var n2 = parseInt(m[1], 10);
    if (n2 > max) max = n2;
  }
  return max || 1;
}

// Export for use in service worker and content scripts
globalThis.BayesParser = { parseProducts, parseCategoryNodes, detectMaxPagesFromHtml };
})();
