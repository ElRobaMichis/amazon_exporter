#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const RESULTS_DIR = path.join(__dirname, 'results');
const PRODUCT_COUNTS = [250, 1000, 2500, 5000];
const ITERATIONS = 300;

const scenarios = PRODUCT_COUNTS.map((count) => {
  const products = generateProducts(count);
  const oldFull = scoreBayesianFull(products.map(cloneProduct));
  const nextPreview = scoreBayesianPreview(products);
  const validation = comparePreview(oldFull, nextPreview);
  const oldRun = runCase(() => scoreBayesianFull(products.map(cloneProduct)));
  const nextRun = runCase(() => scoreBayesianPreview(products));

  return {
    productCount: count,
    validation,
    old: oldRun,
    next: nextRun,
    reduction: {
      meanMsSaved: round(oldRun.meanMs - nextRun.meanMs, 4),
      meanReductionPct: pct(oldRun.meanMs - nextRun.meanMs, oldRun.meanMs),
      p95MsSaved: round(oldRun.p95Ms - nextRun.p95Ms, 4),
      p95ReductionPct: pct(oldRun.p95Ms - nextRun.p95Ms, oldRun.p95Ms)
    }
  };
});

const result = {
  benchmark: 'scoring-preview',
  timestamp: new Date().toISOString(),
  method: 'Local benchmark comparing full cloned Bayesian ranking against extraction-time top5/summary-only preview calculation.',
  iterations: ITERATIONS,
  scenarios,
  conclusion: {
    change: 'Use top5/summary-only Bayesian preview during extraction; results page computes full rankings when it opens.',
    previewEquivalentToFullTop5: scenarios.every((s) => s.validation.ok),
    coverageChanged: false
  }
};

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const outPath = path.join(RESULTS_DIR, `scoring-preview-${stamp()}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log(JSON.stringify({
  saved: outPath,
  scenarios: scenarios.map((s) => ({
    productCount: s.productCount,
    equivalent: s.validation.ok,
    oldMeanMs: s.old.meanMs,
    nextMeanMs: s.next.meanMs,
    meanReductionPct: s.reduction.meanReductionPct,
    p95ReductionPct: s.reduction.p95ReductionPct
  }))
}, null, 2));

function runCase(fn) {
  for (let i = 0; i < 30; i++) fn();
  const times = [];
  let count = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    const result = fn();
    times.push(performance.now() - start);
    count += result.count || result.length || 0;
  }
  times.sort((a, b) => a - b);
  return {
    count,
    meanMs: round(times.reduce((sum, n) => sum + n, 0) / times.length, 4),
    p50Ms: round(percentile(times, 0.50), 4),
    p95Ms: round(percentile(times, 0.95), 4)
  };
}

function scoreBayesianFull(items) {
  const base = computeBayesBase(items);
  items.forEach((p) => {
    p.bayesScore = Math.round(p._bayesRaw * 1000) / 1000;
  });
  items.sort(scoreCompare);
  items.forEach((p, i) => { p.rank = i + 1; });
  items.count = items.length;
  items.summary = makeSummary(items);
  items.base = base;
  return items;
}

function scoreBayesianPreview(items) {
  const base = computeBayesStats(items);
  const top = [];
  let avgSum = 0;

  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    const v = p.reviewCount;
    const bayesRaw = (v / (v + base.m)) * p.rating + (base.m / (v + base.m)) * base.C;
    const candidate = {
      product: p,
      bayesScore: Math.round(bayesRaw * 1000) / 1000,
      confidence: Math.round((v / (v + base.m)) * 100)
    };
    avgSum += candidate.bayesScore;

    if (top.length < 5) {
      top.push(candidate);
      top.sort(compareCandidates);
    } else if (compareCandidates(candidate, top[top.length - 1]) < 0) {
      top[top.length - 1] = candidate;
      top.sort(compareCandidates);
    }
  }

  const scoredPreview = top.map((entry, i) => Object.assign({}, entry.product, {
    bayesScore: entry.bayesScore,
    confidence: entry.confidence,
    rank: i + 1
  }));

  return {
    count: items.length,
    scoredPreview,
    summary: {
      maxScore: scoredPreview.length > 0 ? scoredPreview[0].bayesScore : 0,
      avgScore: items.length > 0 ? Math.round((avgSum / items.length) * 100) / 100 : 0
    }
  };
}

function computeBayesBase(items) {
  const base = computeBayesStats(items);
  items.forEach((p) => {
    const v = p.reviewCount;
    p._bayesRaw = (v / (v + base.m)) * p.rating + (base.m / (v + base.m)) * base.C;
    p.confidence = Math.round((v / (v + base.m)) * 100);
  });
  return base;
}

function computeBayesStats(items) {
  let totalWR = 0;
  let totalR = 0;
  const counts = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    totalWR += p.rating * p.reviewCount;
    totalR += p.reviewCount;
    counts[i] = p.reviewCount;
  }
  counts.sort((a, b) => a - b);
  return {
    C: totalR > 0 ? totalWR / totalR : 0,
    m: Math.max(counts[Math.floor(counts.length * 0.25)] || 1, 50)
  };
}

function makeSummary(scored) {
  let avgSum = 0;
  scored.forEach((p) => { avgSum += p.bayesScore; });
  return {
    maxScore: scored.length > 0 ? scored[0].bayesScore : 0,
    avgScore: scored.length > 0 ? Math.round((avgSum / scored.length) * 100) / 100 : 0
  };
}

function compareCandidates(a, b) {
  const diff = b.bayesScore - a.bayesScore;
  if (diff !== 0) return diff;
  return b.product.reviewCount - a.product.reviewCount;
}

function scoreCompare(a, b) {
  const diff = b.bayesScore - a.bayesScore;
  return diff !== 0 ? diff : b.reviewCount - a.reviewCount;
}

function comparePreview(full, preview) {
  if (full.length !== preview.count) return { ok: false, reason: `count mismatch ${full.length} vs ${preview.count}` };
  if (full.summary.maxScore !== preview.summary.maxScore || full.summary.avgScore !== preview.summary.avgScore) {
    return { ok: false, reason: 'summary mismatch', full: full.summary, preview: preview.summary };
  }
  const fullTop = full.slice(0, 5).map(productSignature);
  const previewTop = preview.scoredPreview.map(productSignature);
  for (let i = 0; i < fullTop.length; i++) {
    if (fullTop[i] !== previewTop[i]) return { ok: false, reason: `top ${i} mismatch`, full: fullTop[i], preview: previewTop[i] };
  }
  return { ok: true };
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
      title: 'Producto Amazon Mexico benchmark ' + i,
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
      siblingAsins: i % 8 === 0 ? ['B' + String(200000000 + i).slice(0, 9)] : []
    });
  }
  return products;
}

function cloneProduct(p) {
  return Object.assign({}, p, { siblingAsins: (p.siblingAsins || []).slice() });
}

function productSignature(p) {
  return [p.asin, p.bayesScore, p.confidence, p.rank].join('\u0001');
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
