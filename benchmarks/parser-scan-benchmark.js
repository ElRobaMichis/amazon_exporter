#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const repoRoot = path.resolve(__dirname, '..');
require(path.join(repoRoot, 'lib', 'parser.js'));

const sourceParser = globalThis.BayesParser.parseProducts;
const RESULTS_DIR = path.join(__dirname, 'results');
const DEFAULT_URL = 'https://www.amazon.com.mx/s?k=mouse';
const DEFAULT_DOMAIN = 'www.amazon.com.mx';

const RE_ASIN = /data-asin="([A-Z0-9]{10})"/;
const RE_TITLE = /<h2[^>]*aria-label="([^"]+)"/;
const RE_STAR = /a-star-mini-(\d)(?:-(\d))?/;
const RE_RATING_EXACT = /a-icon-alt[^>]*>(\d(?:[.,]\d)?)\s/;
const RE_REVIEWS = /aria-label="([\d,.\s]+)\s*(?:ratings|clasificaciones|Sternebewertungen|evaluations|evaluations|voti|classificacoes|beoordelingen|個の評価|ocen|betyg|تقييم)/;
const RE_REVIEWS_UNICODE = /aria-label="([\d,.\s]+)\s*(?:ratings|clasificaciones|Sternebewertungen|évaluations|voti|classificações|beoordelingen|個の評価|ocen|betyg|تقييم)/;
const RE_PRICE = /a-price[^"]*"[\s\S]{0,500}?a-offscreen">([\s\S]*?)<\/span>/;
const RE_LIST = /a-text-price[\s\S]{0,300}?a-offscreen">([\s\S]*?)<\/span>/;
const RE_BOUGHT = /([\d.]+)(K?)\+?\s*(?:bought in past|comprados? el mes|Mal im letzten Monat|achetés? le mois|acquistati nell|comprados? no m[êe]s|gekocht in de afgelopen|先月は|点以上購入)/i;
const RE_BADGE = /a-badge-text[^>]*>([^<]+)/;
const SPLITTER = 'data-component-type="s-search-result"';

const SPONSORED_KEYWORDS = [
  'Sponsored', 'Patrocinado', 'Gesponsert', 'Sponsorise',
  'Sponsorisé', 'Sponsorizzato', 'Gesponsord', 'スポンサー',
  'Sponsorowane', 'Sponsrad', 'برعاية'
];

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

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const iterations = options.iterations || 1000;
  const domain = options.domain || DEFAULT_DOMAIN;
  const html = await loadHtml(options);

  const baselineProducts = parseProductsSplit(html, domain);
  const candidateProducts = parseProductsScan(html, domain);
  const cap13000Products = parseProductsSplitCap13000(html, domain);
  const cap12800Products = parseProductsSplitCap12800(html, domain);
  const cap12500GuardProducts = parseProductsSplitCap12500Guard(html, domain);
  const cap12500Products = parseProductsSplitCap12500(html, domain);
  const cap12000Products = parseProductsSplitCap12000(html, domain);
  const manualProducts = parseProductsSplitManual(html, domain);
  const scanManualProducts = parseProductsScanManual(html, domain);
  const sourceProducts = sourceParser(html, domain);

  const validation = {
    splitVsScan: compareProducts(baselineProducts, candidateProducts),
    splitVsCap13000: compareProducts(baselineProducts, cap13000Products),
    splitVsCap12800: compareProducts(baselineProducts, cap12800Products),
    splitVsCap12500Guard: compareProducts(baselineProducts, cap12500GuardProducts),
    splitVsCap12500: compareProducts(baselineProducts, cap12500Products),
    splitVsCap12000: compareProducts(baselineProducts, cap12000Products),
    splitVsManual: compareProducts(baselineProducts, manualProducts),
    splitVsScanManual: compareProducts(baselineProducts, scanManualProducts),
    splitVsSource: compareProducts(baselineProducts, sourceProducts),
    parsedCount: baselineProducts.length
  };

  const runs = [
    runCase('source-parser', sourceParser, html, domain, iterations),
    runCase('split-baseline', parseProductsSplit, html, domain, iterations),
    runCase('scan-candidate', parseProductsScan, html, domain, iterations),
    runCase('split-cap-13000', parseProductsSplitCap13000, html, domain, iterations),
    runCase('split-cap-12800', parseProductsSplitCap12800, html, domain, iterations),
    runCase('split-cap-12500-guard', parseProductsSplitCap12500Guard, html, domain, iterations),
    runCase('split-cap-12500', parseProductsSplitCap12500, html, domain, iterations),
    runCase('split-cap-12000', parseProductsSplitCap12000, html, domain, iterations),
    runCase('split-manual-hotpaths', parseProductsSplitManual, html, domain, iterations),
    runCase('scan-manual-hotpaths', parseProductsScanManual, html, domain, iterations)
  ];

  const split = runs.find((run) => run.name === 'split-baseline');
  const scan = runs.find((run) => run.name === 'scan-candidate');
  const candidates = runs.filter((run) => run.name !== 'source-parser' && run.name !== 'split-baseline');
  const validByName = {
    'scan-candidate': validation.splitVsScan.ok,
    'split-cap-13000': validation.splitVsCap13000.ok,
    'split-cap-12800': validation.splitVsCap12800.ok,
    'split-cap-12500-guard': validation.splitVsCap12500Guard.ok,
    'split-cap-12500': validation.splitVsCap12500.ok,
    'split-cap-12000': validation.splitVsCap12000.ok,
    'split-manual-hotpaths': validation.splitVsManual.ok,
    'scan-manual-hotpaths': validation.splitVsScanManual.ok
  };
  const validCandidates = candidates.filter((run) => validByName[run.name]);
  const best = validCandidates.slice().sort((a, b) => a.meanMs - b.meanMs)[0];
  const improvementPct = ((split.meanMs - best.meanMs) / split.meanMs) * 100;

  const result = {
    benchmark: 'parser-scan',
    timestamp: new Date().toISOString(),
    input: {
      source: options.fixture ? path.resolve(options.fixture) : (options.url || DEFAULT_URL),
      bytes: Buffer.byteLength(html),
      domain,
      iterations
    },
    validation,
    runs,
    conclusion: {
      scanFasterThanSplit: scan.meanMs < split.meanMs,
      bestCandidate: best.name,
      sourceEquivalent: validation.splitVsSource.ok,
      bestCandidateEquivalent: validByName[best.name],
      invalidCandidates: Object.entries(validByName)
        .filter(([, ok]) => !ok)
        .map(([name]) => name),
      improvementPct: round(improvementPct, 2)
    }
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, `parser-scan-${stamp()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log(JSON.stringify({
    saved: outPath,
    parsedCount: validation.parsedCount,
    sourceEquivalent: validation.splitVsSource.ok,
    bestCandidateEquivalent: validByName[best.name],
    splitMeanMs: split.meanMs,
    scanMeanMs: scan.meanMs,
    bestCandidate: best.name,
    bestMeanMs: best.meanMs,
    improvementPct: result.conclusion.improvementPct
  }, null, 2));
}

function parseArgs(args) {
  const options = {};
  for (const arg of args) {
    const [key, value] = arg.split('=');
    if (key === '--fixture') options.fixture = value;
    else if (key === '--url') options.url = value;
    else if (key === '--domain') options.domain = value;
    else if (key === '--iterations') options.iterations = parseInt(value, 10);
  }
  return options;
}

async function loadHtml(options) {
  if (options.fixture) {
    return fs.readFileSync(path.resolve(options.fixture), 'utf8');
  }

  const url = options.url || DEFAULT_URL;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'accept-language': 'es-MX,es;q=0.9,en;q=0.8'
    }
  });
  if (!response.ok) throw new Error(`Fixture fetch failed: HTTP ${response.status}`);
  const html = await response.text();
  if (html.length < 5000) throw new Error('Fixture fetch returned suspiciously small HTML');
  return html;
}

function runCase(name, fn, html, domain, iterations) {
  for (let i = 0; i < 50; i++) fn(html, domain);

  const times = [];
  let count = 0;
  const totalStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    count += fn(html, domain).length;
    times.push(performance.now() - start);
  }
  const totalMs = performance.now() - totalStart;

  times.sort((a, b) => a - b);
  const meanMs = totalMs / iterations;
  return {
    name,
    iterations,
    totalMs: round(totalMs, 3),
    meanMs: round(meanMs, 6),
    p50Ms: round(percentile(times, 0.50), 6),
    p95Ms: round(percentile(times, 0.95), 6),
    countChecksum: count
  };
}

function parseProductsSplit(html, domain) {
  const firstResult = html.indexOf(SPLITTER);
  if (firstResult === -1) return [];

  const trimStart = Math.max(0, firstResult - 250);
  let trimEnd = html.indexOf('s-pagination-strip', firstResult);
  if (trimEnd === -1) trimEnd = html.indexOf('puis-footer', firstResult);
  if (trimEnd === -1) trimEnd = html.length;
  trimEnd = Math.min(trimEnd + 500, html.length);

  const trimmed = html.substring(trimStart, trimEnd);
  const blocks = trimmed.split(SPLITTER);
  const products = [];

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].substring(0, 15000);
    const prevTail = blocks[i - 1].substring(blocks[i - 1].length - 250);
    const product = parseBlock(prevTail, block, domain);
    if (product) products.push(product);
  }

  return products;
}

function parseProductsSplitCap13000(html, domain) {
  return parseProductsSplitWithCap(html, domain, 13000);
}

function parseProductsSplitCap12800(html, domain) {
  return parseProductsSplitWithCap(html, domain, 12800);
}

function parseProductsSplitCap12500Guard(html, domain) {
  return parseProductsSplitWithCap(html, domain, 12500, 12800);
}

function parseProductsSplitCap12500(html, domain) {
  return parseProductsSplitWithCap(html, domain, 12500);
}

function parseProductsSplitCap12000(html, domain) {
  return parseProductsSplitWithCap(html, domain, 12000);
}

function parseProductsSplitWithCap(html, domain, blockCap, guardCap) {
  const firstResult = html.indexOf(SPLITTER);
  if (firstResult === -1) return [];

  const trimStart = Math.max(0, firstResult - 250);
  let trimEnd = html.indexOf('s-pagination-strip', firstResult);
  if (trimEnd === -1) trimEnd = html.indexOf('puis-footer', firstResult);
  if (trimEnd === -1) trimEnd = html.length;
  trimEnd = Math.min(trimEnd + 500, html.length);

  const trimmed = html.substring(trimStart, trimEnd);
  const blocks = trimmed.split(SPLITTER);
  const products = [];

  for (let i = 1; i < blocks.length; i++) {
    let cap = blockCap;
    if (guardCap && hasPriceNearCap(blocks[i], blockCap)) cap = guardCap;
    const block = blocks[i].substring(0, cap);
    const prevTail = blocks[i - 1].substring(blocks[i - 1].length - 250);
    const product = parseBlock(prevTail, block, domain);
    if (product) products.push(product);
  }

  return products;
}

function hasPriceNearCap(block, blockCap) {
  const guardStart = Math.max(0, blockCap - 700);
  const textPrice = block.indexOf('a-text-price', guardStart);
  if (textPrice !== -1 && textPrice < 15000) return true;
  const price = block.indexOf('a-price', guardStart);
  return price !== -1 && price < 15000;
}

function parseProductsScan(html, domain) {
  const firstResult = html.indexOf(SPLITTER);
  if (firstResult === -1) return [];

  const trimStart = Math.max(0, firstResult - 250);
  let trimEnd = html.indexOf('s-pagination-strip', firstResult);
  if (trimEnd === -1) trimEnd = html.indexOf('puis-footer', firstResult);
  if (trimEnd === -1) trimEnd = html.length;
  trimEnd = Math.min(trimEnd + 500, html.length);

  const trimmed = html.substring(trimStart, trimEnd);
  const products = [];
  let markerIndex = trimmed.indexOf(SPLITTER);

  while (markerIndex !== -1) {
    const blockStart = markerIndex + SPLITTER.length;
    const nextMarker = trimmed.indexOf(SPLITTER, blockStart);
    const blockEnd = nextMarker === -1 ? trimmed.length : nextMarker;
    const block = trimmed.substring(blockStart, Math.min(blockEnd, blockStart + 15000));
    const prevTail = trimmed.substring(Math.max(0, markerIndex - 250), markerIndex);
    const product = parseBlock(prevTail, block, domain);
    if (product) products.push(product);
    markerIndex = nextMarker;
  }

  return products;
}

function parseProductsSplitManual(html, domain) {
  const firstResult = html.indexOf(SPLITTER);
  if (firstResult === -1) return [];

  const trimStart = Math.max(0, firstResult - 250);
  let trimEnd = html.indexOf('s-pagination-strip', firstResult);
  if (trimEnd === -1) trimEnd = html.indexOf('puis-footer', firstResult);
  if (trimEnd === -1) trimEnd = html.length;
  trimEnd = Math.min(trimEnd + 500, html.length);

  const trimmed = html.substring(trimStart, trimEnd);
  const blocks = trimmed.split(SPLITTER);
  const products = [];

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].substring(0, 15000);
    const prevTail = blocks[i - 1].substring(blocks[i - 1].length - 250);
    const product = parseBlockManual(prevTail, block, domain);
    if (product) products.push(product);
  }

  return products;
}

function parseProductsScanManual(html, domain) {
  const firstResult = html.indexOf(SPLITTER);
  if (firstResult === -1) return [];

  const trimStart = Math.max(0, firstResult - 250);
  let trimEnd = html.indexOf('s-pagination-strip', firstResult);
  if (trimEnd === -1) trimEnd = html.indexOf('puis-footer', firstResult);
  if (trimEnd === -1) trimEnd = html.length;
  trimEnd = Math.min(trimEnd + 500, html.length);

  const trimmed = html.substring(trimStart, trimEnd);
  const products = [];
  let markerIndex = trimmed.indexOf(SPLITTER);

  while (markerIndex !== -1) {
    const blockStart = markerIndex + SPLITTER.length;
    const nextMarker = trimmed.indexOf(SPLITTER, blockStart);
    const blockEnd = nextMarker === -1 ? trimmed.length : nextMarker;
    const block = trimmed.substring(blockStart, Math.min(blockEnd, blockStart + 15000));
    const prevTail = trimmed.substring(Math.max(0, markerIndex - 250), markerIndex);
    const product = parseBlockManual(prevTail, block, domain);
    if (product) products.push(product);
    markerIndex = nextMarker;
  }

  return products;
}

function parseBlock(prevTail, block, domain) {
  const am = RE_ASIN.exec(prevTail);
  if (!am) return null;
  const asin = am[1];

  const tm = RE_TITLE.exec(block);
  if (!tm) return null;
  const title = decodeHTMLEntities(tm[1]);

  const exactMatch = RE_RATING_EXACT.exec(block);
  let rating;
  if (exactMatch) {
    rating = parseFloat(exactMatch[1].replace(',', '.'));
  } else {
    const sm = RE_STAR.exec(block);
    rating = sm ? parseFloat(sm[1] + '.' + (sm[2] || '0')) : 0;
  }

  const rvm = RE_REVIEWS_UNICODE.exec(block) || RE_REVIEWS.exec(block);
  const reviewCount = rvm ? parseInt(rvm[1].replace(/[,.\s]/g, ''), 10) : 0;

  const pm = RE_PRICE.exec(block);
  const priceRaw = pm ? pm[1] : '';
  const price = parsePrice(priceRaw);
  const currency = extractCurrency(priceRaw, domain);

  const lm = RE_LIST.exec(block);
  const listPrice = lm ? parsePrice(lm[1]) : 0;

  const bm = RE_BOUGHT.exec(block);
  let boughtCount = 0;
  if (bm) {
    boughtCount = bm[2] === 'K' ? parseFloat(bm[1]) * 1000 : parseInt(bm[1], 10);
  }

  const bdm = RE_BADGE.exec(block);
  const badge = bdm ? bdm[1].trim() : '';
  const isSponsored = SPONSORED_KEYWORDS.some((kw) => block.indexOf(kw) !== -1);

  const dpLinks = block.match(/href="\/[^"]*\/dp\/[A-Z0-9]{10}/g) || [];
  const siblingAsins = [];
  dpLinks.forEach((link) => {
    const m = link.match(/\/dp\/([A-Z0-9]{10})/);
    if (m && m[1] !== asin && siblingAsins.indexOf(m[1]) === -1) siblingAsins.push(m[1]);
  });

  const urlMatch = block.match(/href="(\/[^"]*\/dp\/[A-Z0-9]{10}[^"]*)"/);
  const productUrl = urlMatch ? urlMatch[1] : `/dp/${asin}`;

  const imgMatch = block.match(/src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
  const imageUrl = imgMatch ? imgMatch[1] : '';

  return {
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
  };
}

function parseBlockManual(prevTail, block, domain) {
  const asin = extractAsin(prevTail);
  if (!asin) return null;

  const titleRaw = extractTitle(block);
  if (!titleRaw) return null;
  const title = decodeHTMLEntities(titleRaw);

  const rating = extractRating(block);

  const rvm = RE_REVIEWS_UNICODE.exec(block) || RE_REVIEWS.exec(block);
  const reviewCount = rvm ? parseInt(rvm[1].replace(/[,.\s]/g, ''), 10) : 0;

  const pm = RE_PRICE.exec(block);
  const priceRaw = pm ? pm[1] : '';
  const price = parsePrice(priceRaw);
  const currency = extractCurrency(priceRaw, domain);

  const lm = RE_LIST.exec(block);
  const listPrice = lm ? parsePrice(lm[1]) : 0;

  const bm = RE_BOUGHT.exec(block);
  let boughtCount = 0;
  if (bm) {
    boughtCount = bm[2] === 'K' ? parseFloat(bm[1]) * 1000 : parseInt(bm[1], 10);
  }

  const bdm = RE_BADGE.exec(block);
  const badge = bdm ? bdm[1].trim() : '';
  const isSponsored = SPONSORED_KEYWORDS.some((kw) => block.indexOf(kw) !== -1);

  const dpLinks = block.match(/href="\/[^"]*\/dp\/[A-Z0-9]{10}/g) || [];
  const siblingAsins = [];
  dpLinks.forEach((link) => {
    const m = link.match(/\/dp\/([A-Z0-9]{10})/);
    if (m && m[1] !== asin && siblingAsins.indexOf(m[1]) === -1) siblingAsins.push(m[1]);
  });

  const urlMatch = block.match(/href="(\/[^"]*\/dp\/[A-Z0-9]{10}[^"]*)"/);
  const productUrl = urlMatch ? urlMatch[1] : `/dp/${asin}`;

  const imgMatch = block.match(/src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
  const imageUrl = imgMatch ? imgMatch[1] : '';

  return {
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
  };
}

function extractAsin(prevTail) {
  const marker = 'data-asin="';
  const start = prevTail.lastIndexOf(marker);
  if (start === -1) return '';
  const asin = prevTail.substring(start + marker.length, start + marker.length + 10);
  return isAsin(asin) ? asin : '';
}

function extractTitle(block) {
  const h2Start = block.indexOf('<h2');
  if (h2Start === -1) return '';
  const h2End = block.indexOf('>', h2Start);
  if (h2End === -1) return '';
  const marker = 'aria-label="';
  const titleStart = block.indexOf(marker, h2Start);
  if (titleStart === -1 || titleStart > h2End) return '';
  const valueStart = titleStart + marker.length;
  const valueEnd = block.indexOf('"', valueStart);
  return valueEnd === -1 ? '' : block.substring(valueStart, valueEnd);
}

function extractRating(block) {
  const marker = 'a-icon-alt';
  const iconStart = block.indexOf(marker);
  if (iconStart !== -1) {
    const valueStart = block.indexOf('>', iconStart);
    if (valueStart !== -1) {
      const first = block.charCodeAt(valueStart + 1);
      if (first >= 48 && first <= 57) {
        const decimal = block.charAt(valueStart + 2);
        const decimalDigit = block.charCodeAt(valueStart + 3);
        if ((decimal === '.' || decimal === ',') && decimalDigit >= 48 && decimalDigit <= 57) {
          return parseFloat(block.charAt(valueStart + 1) + '.' + block.charAt(valueStart + 3));
        }
        return first - 48;
      }
    }
  }

  const sm = RE_STAR.exec(block);
  return sm ? parseFloat(sm[1] + '.' + (sm[2] || '0')) : 0;
}

function isAsin(value) {
  if (!value || value.length !== 10) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const digit = c >= 48 && c <= 57;
    const upper = c >= 65 && c <= 90;
    if (!digit && !upper) return false;
  }
  return true;
}

function parsePrice(priceStr) {
  if (!priceStr) return 0;
  const cleaned = priceStr.replace(/[^\d,.\s]/g, '').trim();
  if (!cleaned) return 0;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  if (lastComma > lastDot) {
    return parseFloat(cleaned.replace(/\./g, '').replace(',', '.')) || 0;
  }
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

function extractCurrency(priceStr, domain) {
  if (!priceStr) return domainFallback(domain);
  const s = priceStr.trim();
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
  if (s.includes('$')) return domainFallback(domain);
  return domainFallback(domain);
}

function domainFallback(domain) {
  if (!domain) return 'USD';
  for (const [d, c] of Object.entries(DOMAIN_CURRENCY)) {
    if (domain.includes(d)) return c;
  }
  return 'USD';
}

function compareProducts(a, b) {
  if (a.length !== b.length) {
    return { ok: false, reason: `count mismatch ${a.length} vs ${b.length}` };
  }

  for (let i = 0; i < a.length; i++) {
    const left = productSignature(a[i]);
    const right = productSignature(b[i]);
    if (left !== right) {
      return { ok: false, reason: `product ${i} mismatch`, left, right };
    }
  }

  return { ok: true };
}

function productSignature(p) {
  return [
    p.asin,
    p.title,
    p.rating,
    p.reviewCount,
    p.price,
    p.listPrice,
    p.currency,
    p.boughtCount,
    p.badge,
    p.isSponsored,
    p.productUrl,
    p.imageUrl,
    p.discount,
    (p.siblingAsins || []).join('|')
  ].join('\u0001');
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index];
}

function round(value, digits) {
  const mult = 10 ** digits;
  return Math.round(value * mult) / mult;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
