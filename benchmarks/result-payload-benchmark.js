#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const RESULTS_DIR = path.join(__dirname, 'results');
const PRODUCT_COUNTS = [250, 1000, 2500, 5000];
const ITERATIONS = 100;

const scenarios = PRODUCT_COUNTS.map((count) => {
  const rawProducts = generateProducts(count);
  const scored = scoreBayesian(rawProducts.map(cloneProduct));
  const summary = makeSummary(scored);
  const common = {
    stats: { pagesSucceeded: Math.ceil(count / 30), pagesFailed: 0, totalPages: Math.ceil(count / 30), elapsedMs: 6000, captchaHit: false },
    scoringMode: 'bayesian',
    query: 'mouse',
    url: 'https://www.amazon.com.mx/s?k=mouse',
    timestamp: Date.now()
  };

  const oldPayload = Object.assign({}, common, {
    rawProducts,
    scored,
    summary
  });
  const nextPayload = Object.assign({}, common, {
    rawProducts,
    scoredPreview: scored.slice(0, 5),
    scoredCount: scored.length,
    summary
  });

  const oldRun = runStringify(oldPayload);
  const nextRun = runStringify(nextPayload);

  return {
    productCount: count,
    old: oldRun,
    next: nextRun,
    reduction: {
      bytesSaved: oldRun.bytes - nextRun.bytes,
      byteReductionPct: pct(oldRun.bytes - nextRun.bytes, oldRun.bytes),
      stringifyMsSaved: round(oldRun.meanMs - nextRun.meanMs, 4),
      stringifyReductionPct: pct(oldRun.meanMs - nextRun.meanMs, oldRun.meanMs)
    }
  };
});

const result = {
  benchmark: 'result-payload',
  timestamp: new Date().toISOString(),
  method: 'Local JSON serialization proxy for chrome.storage/message payload cost using extension-shaped product objects.',
  iterations: ITERATIONS,
  scenarios,
  conclusion: {
    change: 'Store rawProducts plus scoredPreview/scoredCount instead of duplicating the full scored product array.',
    coverageChanged: false,
    rankingChanged: false
  }
};

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const outPath = path.join(RESULTS_DIR, `result-payload-${stamp()}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log(JSON.stringify({
  saved: outPath,
  scenarios: scenarios.map((s) => ({
    productCount: s.productCount,
    oldBytes: s.old.bytes,
    nextBytes: s.next.bytes,
    byteReductionPct: s.reduction.byteReductionPct,
    stringifyReductionPct: s.reduction.stringifyReductionPct
  }))
}, null, 2));

function runStringify(payload) {
  const times = [];
  let bytes = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    const json = JSON.stringify(payload);
    times.push(performance.now() - start);
    bytes = Buffer.byteLength(json);
  }
  times.sort((a, b) => a - b);
  return {
    bytes,
    meanMs: round(times.reduce((sum, n) => sum + n, 0) / times.length, 4),
    p50Ms: round(percentile(times, 0.50), 4),
    p95Ms: round(percentile(times, 0.95), 4)
  };
}

function generateProducts(count) {
  const products = [];
  for (let i = 0; i < count; i++) {
    const asin = 'B' + String(100000000 + i).slice(0, 9);
    const rating = Math.round((3.4 + (i % 17) / 10) * 10) / 10;
    const reviewCount = 20 + ((i * 73) % 15000);
    const price = Math.round((99 + (i * 31) % 2800) * 100) / 100;
    const listPrice = i % 3 === 0 ? Math.round(price * 1.22 * 100) / 100 : 0;
    products.push({
      asin,
      title: 'Producto Amazon Mexico benchmark ' + i + ' con nombre suficientemente largo para simular tarjetas reales',
      rating,
      reviewCount,
      price,
      listPrice,
      currency: 'MXN',
      boughtCount: i % 4 === 0 ? 500 : 0,
      badge: i % 11 === 0 ? 'Más vendido' : '',
      isSponsored: i % 13 === 0,
      productUrl: '/Producto-Benchmark/dp/' + asin + '/ref=sr_1_' + i,
      imageUrl: 'https://m.media-amazon.com/images/I/' + asin + '._AC_UL320_.jpg',
      discount: listPrice > 0 ? Math.round((1 - price / listPrice) * 100) : 0,
      siblingAsins: i % 8 === 0 ? ['B' + String(200000000 + i).slice(0, 9), 'B' + String(300000000 + i).slice(0, 9)] : []
    });
  }
  return products;
}

function scoreBayesian(items) {
  let totalWR = 0;
  let totalR = 0;
  for (const p of items) {
    totalWR += p.rating * p.reviewCount;
    totalR += p.reviewCount;
  }
  const C = totalR > 0 ? totalWR / totalR : 0;
  const counts = items.map((p) => p.reviewCount).sort((a, b) => a - b);
  const m = Math.max(counts[Math.floor(counts.length * 0.25)] || 1, 50);
  for (const p of items) {
    const v = p.reviewCount;
    p._bayesRaw = (v / (v + m)) * p.rating + (m / (v + m)) * C;
    p.confidence = Math.round((v / (v + m)) * 100);
    p.bayesScore = Math.round(p._bayesRaw * 1000) / 1000;
  }
  items.sort((a, b) => {
    const diff = b.bayesScore - a.bayesScore;
    return diff !== 0 ? diff : b.reviewCount - a.reviewCount;
  });
  items.forEach((p, i) => { p.rank = i + 1; });
  return items;
}

function makeSummary(scored) {
  let avgSum = 0;
  scored.forEach((p) => { avgSum += p.bayesScore; });
  return {
    maxScore: scored.length > 0 ? scored[0].bayesScore : 0,
    avgScore: scored.length > 0 ? Math.round((avgSum / scored.length) * 100) / 100
      : 0
  };
}

function cloneProduct(p) {
  return Object.assign({}, p, { siblingAsins: (p.siblingAsins || []).slice() });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function pct(delta, base) {
  return base === 0 ? 0 : round((delta / base) * 100, 2);
}

function round(value, digits) {
  const mult = 10 ** digits;
  return Math.round(value * mult) / mult;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
