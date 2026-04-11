#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const RESULTS_DIR = path.join(__dirname, 'results');
const PRODUCT_COUNTS = [250, 1000, 2500, 5000, 10000];
const ITERATIONS = 500;

const scenarios = [];
for (const count of PRODUCT_COUNTS) {
  const allScored = generateScoredProducts(count);
  scenarios.push(measureScenario(allScored, { filter: 'all', query: '', sort: 'score' }));
  scenarios.push(measureScenario(allScored, { filter: 'highconf', query: '', sort: 'score' }));
  scenarios.push(measureScenario(allScored, { filter: 'deals', query: 'mouse', sort: 'score' }));
}

const result = {
  benchmark: 'apply-filter-default-score-sort',
  timestamp: new Date().toISOString(),
  method: 'Local JS model of results.js applyFilters default score path. allScored is already sorted by score; Array.filter preserves order.',
  iterations: ITERATIONS,
  scenarios,
  conclusion: {
    change: 'Skip redundant default score sort in applyFilters; keep explicit alternate sorts unchanged.',
    allScenariosEquivalent: scenarios.every((s) => s.validation.ok),
    bestReductionPct: Math.max.apply(null, scenarios.map((s) => s.reduction.meanReductionPct)),
    worstReductionPct: Math.min.apply(null, scenarios.map((s) => s.reduction.meanReductionPct))
  }
};

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const outPath = path.join(RESULTS_DIR, `apply-filter-sort-${stamp()}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log(JSON.stringify({
  saved: outPath,
  scenarios: scenarios.map((s) => ({
    productCount: s.productCount,
    filter: s.input.filter,
    query: s.input.query,
    equivalent: s.validation.ok,
    oldMeanMs: s.old.meanMs,
    nextMeanMs: s.next.meanMs,
    meanReductionPct: s.reduction.meanReductionPct
  }))
}, null, 2));

function measureScenario(allScored, input) {
  const oldResult = applyFiltersOld(allScored, input);
  const nextResult = applyFiltersNext(allScored, input);
  const validation = compareAsins(oldResult, nextResult);
  const oldRun = runCase(() => applyFiltersOld(allScored, input));
  const nextRun = runCase(() => applyFiltersNext(allScored, input));
  return {
    productCount: allScored.length,
    input,
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
}

function applyFiltersOld(allScored, input) {
  let items = allScored.slice();
  items = applyFilterAndQuery(items, input);
  if (input.sort === 'rating') items.sort((a, b) => b.rating - a.rating);
  else if (input.sort === 'reviewCount') items.sort((a, b) => b.reviewCount - a.reviewCount);
  else if (input.sort === 'price-asc') items.sort((a, b) => (a.price || 9999) - (b.price || 9999));
  else if (input.sort === 'price-desc') items.sort((a, b) => (b.price || 0) - (a.price || 0));
  else if (input.sort === 'discount') items.sort((a, b) => b.discount - a.discount);
  else items.sort((a, b) => b.bayesScore - a.bayesScore);
  return items;
}

function applyFiltersNext(allScored, input) {
  let items = allScored.slice();
  items = applyFilterAndQuery(items, input);
  if (input.sort === 'rating') items.sort((a, b) => b.rating - a.rating);
  else if (input.sort === 'reviewCount') items.sort((a, b) => b.reviewCount - a.reviewCount);
  else if (input.sort === 'price-asc') items.sort((a, b) => (a.price || 9999) - (b.price || 9999));
  else if (input.sort === 'price-desc') items.sort((a, b) => (b.price || 0) - (a.price || 0));
  else if (input.sort === 'discount') items.sort((a, b) => b.discount - a.discount);
  return items;
}

function applyFilterAndQuery(items, input) {
  if (input.filter === 'top15') items = items.slice(0, 15);
  else if (input.filter === 'highconf') items = items.filter((p) => p.confidence >= 75);
  else if (input.filter === 'deals') items = items.filter((p) => p.discount > 0);

  if (input.query) {
    const q = input.query.toLowerCase();
    items = items.filter((p) => p.title.toLowerCase().indexOf(q) !== -1);
  }
  return items;
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

function generateScoredProducts(count) {
  const products = [];
  for (let i = 0; i < count; i++) {
    products.push({
      asin: 'B' + String(100000000 + i).slice(0, 9),
      title: (i % 3 === 0 ? 'mouse ' : 'teclado ') + 'benchmark ' + i,
      bayesScore: Math.round((5 - i / count) * 1000) / 1000,
      rating: Math.round((3.5 + (i % 15) / 10) * 10) / 10,
      reviewCount: 20 + ((i * 73) % 15000),
      price: 99 + ((i * 31) % 2800),
      discount: i % 4 === 0 ? 20 : 0,
      confidence: i % 5 === 0 ? 90 : 60
    });
  }
  products.sort((a, b) => b.bayesScore - a.bayesScore);
  return products;
}

function compareAsins(a, b) {
  if (a.length !== b.length) return { ok: false, reason: `length mismatch ${a.length} vs ${b.length}` };
  for (let i = 0; i < a.length; i++) {
    if (a[i].asin !== b[i].asin) return { ok: false, reason: `asin mismatch at ${i}`, left: a[i].asin, right: b[i].asin };
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
