#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const RESULTS_DIR = path.join(__dirname, 'results');
const PRODUCT_COUNTS = [250, 1000, 2500, 5000, 10000];
const ITERATIONS = 500;

const scenarios = PRODUCT_COUNTS.map((count) => {
  const products = generateDedupedProducts(count);
  const oldResult = deduplicateVariants(cloneProducts(products));
  const nextResult = cloneProducts(products);
  const validation = compareProducts(oldResult, nextResult);
  const oldRun = runCase(() => deduplicateVariants(cloneProducts(products)));
  const nextRun = runCase(() => cloneProducts(products));
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
  benchmark: 'results-dedup-skip',
  timestamp: new Date().toISOString(),
  method: 'Local JS benchmark for results.js mode switch path. New extraction payloads already pass filtered products through deduplicateVariants before storage.',
  iterations: ITERATIONS,
  scenarios,
  conclusion: {
    change: 'Mark new payloads as variantDeduped and skip the second results-page deduplicateVariants pass for them.',
    allScenariosEquivalent: scenarios.every((s) => s.validation.ok),
    coverageChanged: false
  }
};

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const outPath = path.join(RESULTS_DIR, `results-dedup-skip-${stamp()}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log(JSON.stringify({
  saved: outPath,
  scenarios: scenarios.map((s) => ({
    productCount: s.productCount,
    equivalent: s.validation.ok,
    oldMeanMs: s.old.meanMs,
    nextMeanMs: s.next.meanMs,
    meanReductionPct: s.reduction.meanReductionPct
  }))
}, null, 2));

function deduplicateVariants(products) {
  const parent = {};
  function find(x) {
    if (!parent[x]) parent[x] = x;
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  products.forEach((p) => {
    if (p.siblingAsins && p.siblingAsins.length > 0) {
      p.siblingAsins.forEach((sib) => { union(p.asin, sib); });
    }
  });

  const groups = {};
  products.forEach((p) => {
    const root = find(p.asin);
    if (!groups[root]) groups[root] = [];
    groups[root].push(p);
  });

  const result = [];
  Object.keys(groups).forEach((root) => {
    const group = groups[root];
    if (group.length === 1) { result.push(group[0]); return; }
    group.sort((a, b) => {
      if (a.price > 0 && b.price > 0) return a.price - b.price;
      if (a.price > 0) return -1;
      if (b.price > 0) return 1;
      return 0;
    });
    result.push(group[0]);
  });

  return result;
}

function cloneProducts(arr) {
  return arr.map((p) => Object.assign({}, p, { siblingAsins: (p.siblingAsins || []).slice() }));
}

function runCase(fn) {
  for (let i = 0; i < 20; i++) fn();
  const times = [];
  let count = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    const result = fn();
    times.push(performance.now() - start);
    count += result.length;
  }
  times.sort((a, b) => a - b);
  return {
    count,
    meanMs: round(times.reduce((sum, n) => sum + n, 0) / times.length, 4),
    p50Ms: round(percentile(times, 0.50), 4),
    p95Ms: round(percentile(times, 0.95), 4)
  };
}

function generateDedupedProducts(count) {
  const products = [];
  for (let i = 0; i < count; i++) {
    products.push({
      asin: 'B' + String(100000000 + i).slice(0, 9),
      title: 'Producto ya deduplicado ' + i,
      rating: 4.2,
      reviewCount: 100 + i,
      price: 100 + i,
      siblingAsins: []
    });
  }
  return products;
}

function compareProducts(a, b) {
  if (a.length !== b.length) return { ok: false, reason: `length mismatch ${a.length} vs ${b.length}` };
  for (let i = 0; i < a.length; i++) {
    if (a[i].asin !== b[i].asin) return { ok: false, reason: `asin mismatch at ${i}` };
  }
  return { ok: true };
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
