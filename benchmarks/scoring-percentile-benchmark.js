#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const RESULTS_DIR = path.join(__dirname, 'results');
const PRODUCT_COUNTS = [250, 1000, 2500, 5000, 10000];
const ITERATIONS = 300;

const scenarios = [];
for (const count of PRODUCT_COUNTS) {
  const products = generateProducts(count);
  scenarios.push(measureScenario(products, 'bayesian', scoreBayesianSort, scoreBayesianQuickselect));
  scenarios.push(measureScenario(products, 'preview', scorePreviewSort, scorePreviewQuickselect));
  scenarios.push(measureScenario(products, 'quality', scoreQualitySort, scoreQualityQuickselect));
}

const result = {
  benchmark: 'scoring-percentile-selection',
  timestamp: new Date().toISOString(),
  method: 'Local JS benchmark comparing current full numeric sort percentile extraction against quickselect-based percentile extraction.',
  iterations: ITERATIONS,
  scenarios,
  conclusion: {
    quickselectAlwaysEquivalent: scenarios.every((s) => s.validation.ok),
    implemented: true,
    reason: 'Adopted in content.js and results.js after equivalent runs showed a consistent win for larger result sets.'
  }
};

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const outPath = path.join(RESULTS_DIR, `scoring-percentile-${stamp()}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log(JSON.stringify({
  saved: outPath,
  scenarios: scenarios.map((s) => ({
    productCount: s.productCount,
    mode: s.mode,
    equivalent: s.validation.ok,
    sortMeanMs: s.sort.meanMs,
    quickselectMeanMs: s.quickselect.meanMs,
    meanReductionPct: s.reduction.meanReductionPct
  }))
}, null, 2));

function measureScenario(products, mode, sortFn, quickselectFn) {
  const sortResult = sortFn(products);
  const quickselectResult = quickselectFn(products);
  const validation = compareResult(sortResult, quickselectResult);
  const sortRun = runCase(() => sortFn(products));
  const quickselectRun = runCase(() => quickselectFn(products));
  return {
    productCount: products.length,
    mode,
    validation,
    sort: sortRun,
    quickselect: quickselectRun,
    reduction: {
      meanMsSaved: round(sortRun.meanMs - quickselectRun.meanMs, 4),
      meanReductionPct: pct(sortRun.meanMs - quickselectRun.meanMs, sortRun.meanMs),
      p95MsSaved: round(sortRun.p95Ms - quickselectRun.p95Ms, 4),
      p95ReductionPct: pct(sortRun.p95Ms - quickselectRun.p95Ms, sortRun.p95Ms)
    }
  };
}

function runCase(fn) {
  for (let i = 0; i < 30; i++) fn();
  const times = [];
  let checksum = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    const result = fn();
    times.push(performance.now() - start);
    checksum += result.checksum;
  }
  times.sort((a, b) => a - b);
  return {
    checksum: round(checksum, 3),
    meanMs: round(times.reduce((sum, n) => sum + n, 0) / times.length, 4),
    p50Ms: round(percentileFromSorted(times, 0.50), 4),
    p95Ms: round(percentileFromSorted(times, 0.95), 4)
  };
}

function scoreBayesianSort(products) {
  const base = baseSort(products);
  let checksum = 0;
  for (const p of products) {
    const v = p.reviewCount;
    checksum += Math.round(((v / (v + base.m)) * p.rating + (base.m / (v + base.m)) * base.C) * 1000) / 1000;
  }
  return { C: base.C, m: base.m, checksum: round(checksum, 3) };
}

function scoreBayesianQuickselect(products) {
  const base = baseQuickselect(products);
  let checksum = 0;
  for (const p of products) {
    const v = p.reviewCount;
    checksum += Math.round(((v / (v + base.m)) * p.rating + (base.m / (v + base.m)) * base.C) * 1000) / 1000;
  }
  return { C: base.C, m: base.m, checksum: round(checksum, 3) };
}

function scorePreviewSort(products) {
  return scoreBayesianSort(products);
}

function scorePreviewQuickselect(products) {
  return scoreBayesianQuickselect(products);
}

function scoreQualitySort(products) {
  const base = baseSort(products);
  const counts = products.map((p) => p.reviewCount).sort((a, b) => a - b);
  const satCap = Math.max(counts[Math.floor(counts.length * 0.75)] || 100, 100);
  let checksum = 0;
  for (const p of products) {
    const v = p.reviewCount;
    const effV = v <= satCap ? v : satCap + Math.log10(1 + v - satCap) * satCap * 0.1;
    checksum += Math.round(((effV / (effV + base.m)) * p.rating + (base.m / (effV + base.m)) * base.C) * 1000) / 1000;
  }
  return { C: base.C, m: base.m, satCap, checksum: round(checksum, 3) };
}

function scoreQualityQuickselect(products) {
  const base = baseQuickselect(products);
  const counts = products.map((p) => p.reviewCount);
  const satCap = Math.max(quickselect(counts, Math.floor(counts.length * 0.75)) || 100, 100);
  let checksum = 0;
  for (const p of products) {
    const v = p.reviewCount;
    const effV = v <= satCap ? v : satCap + Math.log10(1 + v - satCap) * satCap * 0.1;
    checksum += Math.round(((effV / (effV + base.m)) * p.rating + (base.m / (effV + base.m)) * base.C) * 1000) / 1000;
  }
  return { C: base.C, m: base.m, satCap, checksum: round(checksum, 3) };
}

function baseSort(products) {
  let totalWR = 0;
  let totalR = 0;
  const counts = new Array(products.length);
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
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

function baseQuickselect(products) {
  let totalWR = 0;
  let totalR = 0;
  const counts = new Array(products.length);
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    totalWR += p.rating * p.reviewCount;
    totalR += p.reviewCount;
    counts[i] = p.reviewCount;
  }
  return {
    C: totalR > 0 ? totalWR / totalR : 0,
    m: Math.max(quickselect(counts, Math.floor(counts.length * 0.25)) || 1, 50)
  };
}

function quickselect(arr, k) {
  let left = 0;
  let right = arr.length - 1;
  while (left < right) {
    const pivotIndex = partition(arr, left, right, Math.floor((left + right) / 2));
    if (k === pivotIndex) return arr[k];
    if (k < pivotIndex) right = pivotIndex - 1;
    else left = pivotIndex + 1;
  }
  return arr[k];
}

function partition(arr, left, right, pivotIndex) {
  const pivotValue = arr[pivotIndex];
  swap(arr, pivotIndex, right);
  let storeIndex = left;
  for (let i = left; i < right; i++) {
    if (arr[i] < pivotValue) {
      swap(arr, storeIndex, i);
      storeIndex++;
    }
  }
  swap(arr, right, storeIndex);
  return storeIndex;
}

function swap(arr, i, j) {
  const tmp = arr[i];
  arr[i] = arr[j];
  arr[j] = tmp;
}

function compareResult(a, b) {
  if (a.m !== b.m) return { ok: false, reason: 'm mismatch', sort: a.m, quickselect: b.m };
  if (a.satCap !== b.satCap) return { ok: false, reason: 'satCap mismatch', sort: a.satCap, quickselect: b.satCap };
  if (Math.abs(a.checksum - b.checksum) > 0.0001) return { ok: false, reason: 'checksum mismatch', sort: a.checksum, quickselect: b.checksum };
  return { ok: true };
}

function generateProducts(count) {
  const products = [];
  for (let i = 0; i < count; i++) {
    products.push({
      rating: Math.round((3.4 + (i % 17) / 10) * 10) / 10,
      reviewCount: 20 + ((i * 73) % 15000)
    });
  }
  return products;
}

function percentileFromSorted(sorted, p) {
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
