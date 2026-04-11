#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const repoRoot = path.resolve(__dirname, '..');
require(path.join(repoRoot, 'lib', 'parser.js'));

const RESULTS_DIR = path.join(__dirname, 'results');
const DEFAULT_URL = 'https://www.amazon.com.mx/gp/aw/s?k=mouse';
const DEFAULT_DOMAIN = 'www.amazon.com.mx';

const RE_ASIN = /data-asin="([A-Z0-9]{10})"/;
const RE_TITLE = /<h2[^>]*aria-label="([^"]+)"/;
const RE_STAR = /a-star-mini-(\d)(?:-(\d))?/;
const RE_RATING_EXACT = /a-icon-alt[^>]*>(\d(?:[.,]\d)?)\s/;
const RE_REVIEWS = /aria-label="([\d,.\s]+)\s*(?:ratings|clasificaciones|Sternebewertungen|évaluations|voti|classificações|beoordelingen|個の評価|ocen|betyg|تقييم)/;
const RE_PRICE = /a-price[^"]*"[\s\S]{0,500}?a-offscreen">([\s\S]*?)<\/span>/;
const RE_LIST = /a-text-price[\s\S]{0,300}?a-offscreen">([\s\S]*?)<\/span>/;
const RE_BOUGHT = /([\d.]+)(K?)\+?\s*(?:bought in past|comprados? el mes|Mal im letzten Monat|achetés? le mois|acquistati nell|comprados? no m[êe]s|gekocht in de afgelopen|先月は|点以上購入)/i;
const RE_BADGE = /a-badge-text[^>]*>([^<]+)/;
const RE_DP_HREF = /href="(\/[^"]*\/dp\/([A-Z0-9]{10})[^"]*)"/g;
const RE_IMG = /src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/;
const SPLITTER = 'data-component-type="s-search-result"';
const BLOCK_CAP = 12800;

const SPONSORED_KEYWORDS = [
  'Sponsored', 'Patrocinado', 'Gesponsert', 'Sponsorisé',
  'Sponsorizzato', 'Gesponsord', 'スポンサー',
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

  const sourceProducts = globalThis.BayesParser.parseProducts(html, domain);
  const combinedProducts = parseProductsCombinedLinks(html, domain);
  const validation = compareProducts(sourceProducts, combinedProducts);

  const runs = [
    runCase('source-parser', globalThis.BayesParser.parseProducts, html, domain, iterations),
    runCase('combined-dp-link-pass', parseProductsCombinedLinks, html, domain, iterations)
  ];
  const source = runs[0];
  const combined = runs[1];

  const result = {
    benchmark: 'parser-link-hotpath',
    timestamp: new Date().toISOString(),
    input: {
      source: options.fixture ? path.resolve(options.fixture) : (options.url || DEFAULT_URL),
      bytes: Buffer.byteLength(html),
      domain,
      iterations
    },
    validation: {
      sourceVsCombinedLinks: validation,
      parsedCount: sourceProducts.length
    },
    runs,
    conclusion: {
      combinedLinksEquivalent: validation.ok,
      sourceMeanMs: source.meanMs,
      combinedMeanMs: combined.meanMs,
      improvementPct: round(((source.meanMs - combined.meanMs) / source.meanMs) * 100, 2)
    }
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, `parser-link-hotpath-${stamp()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log(JSON.stringify({
    saved: outPath,
    parsedCount: sourceProducts.length,
    equivalent: validation.ok,
    sourceMeanMs: source.meanMs,
    combinedMeanMs: combined.meanMs,
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
  if (options.fixture) return fs.readFileSync(path.resolve(options.fixture), 'utf8');

  const response = await fetch(options.url || DEFAULT_URL, {
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
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    count += fn(html, domain).length;
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return {
    name,
    count,
    meanMs: round(times.reduce((sum, n) => sum + n, 0) / times.length, 4),
    p50Ms: round(percentile(times, 0.50), 4),
    p95Ms: round(percentile(times, 0.95), 4)
  };
}

function parseProductsCombinedLinks(html, domain) {
  const firstResult = html.indexOf(SPLITTER);
  if (firstResult === -1) return [];

  const trimStart = Math.max(0, firstResult - 250);
  let trimEnd = html.indexOf('s-pagination-strip', firstResult);
  if (trimEnd === -1) trimEnd = html.indexOf('puis-footer', firstResult);
  if (trimEnd === -1) trimEnd = html.length;
  trimEnd = Math.min(trimEnd + 500, html.length);

  const blocks = html.substring(trimStart, trimEnd).split(SPLITTER);
  const products = [];

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].substring(0, BLOCK_CAP);
    const prevTail = blocks[i - 1].substring(blocks[i - 1].length - 250);
    const product = parseBlockCombinedLinks(prevTail, block, domain);
    if (product) products.push(product);
  }

  return products;
}

function parseBlockCombinedLinks(prevTail, block, domain) {
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

  const rvm = RE_REVIEWS.exec(block);
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
    boughtCount = bm[2] === 'K'
      ? parseFloat(bm[1]) * 1000
      : parseInt(bm[1], 10);
  }

  const bdm = RE_BADGE.exec(block);
  const badge = bdm ? bdm[1].trim() : '';
  const isSponsored = SPONSORED_KEYWORDS.some((kw) => block.indexOf(kw) !== -1);

  const siblingAsins = [];
  let productUrl = `/dp/${asin}`;
  let hrefMatch;
  RE_DP_HREF.lastIndex = 0;
  while ((hrefMatch = RE_DP_HREF.exec(block)) !== null) {
    if (productUrl === `/dp/${asin}`) productUrl = hrefMatch[1];
    const linkAsin = hrefMatch[2];
    if (linkAsin !== asin && siblingAsins.indexOf(linkAsin) === -1) siblingAsins.push(linkAsin);
  }

  const imgMatch = RE_IMG.exec(block);
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
  if (a.length !== b.length) return { ok: false, reason: `count mismatch ${a.length} vs ${b.length}` };

  for (let i = 0; i < a.length; i++) {
    const left = productSignature(a[i]);
    const right = productSignature(b[i]);
    if (left !== right) return { ok: false, reason: `product ${i} mismatch`, left, right };
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
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function round(value, digits) {
  const mult = 10 ** digits;
  return Math.round(value * mult) / mult;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
