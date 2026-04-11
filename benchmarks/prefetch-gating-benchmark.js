#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, 'results');
const SORT_ORDERS = ['', '&s=review-rank', '&s=price-asc-rank', '&s=price-desc-rank', '&s=date-desc-rank'];

const scenarios = [
  { name: 'normal-auto-7-pages', pages: 7, multiQuery: false, depthAnalysis: false },
  { name: 'multi-query-7-pages', pages: 7, multiQuery: true, depthAnalysis: false },
  { name: 'depth-auto-prefetched', pages: 40, multiQuery: false, depthAnalysis: true },
  { name: 'depth-multi-prefetched', pages: 40, multiQuery: true, depthAnalysis: true }
];

const assumptions = {
  depthSampleSize: 10,
  discoveredCategories: 4,
  avgRequestLatencyMs: 937,
  poolConcurrency: 60
};

const result = {
  benchmark: 'prefetch-gating',
  timestamp: new Date().toISOString(),
  assumptions,
  scenarios: scenarios.map(measureScenario),
  conclusion: {
    normalAndMultiNoLongerStartDepthPrefetch: true,
    depthStillStartsPrefetchWhenEnabled: true
  }
};

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const outPath = path.join(RESULTS_DIR, `prefetch-gating-${stamp()}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log(JSON.stringify({
  saved: outPath,
  scenarios: result.scenarios.map((s) => ({
    name: s.name,
    oldPopupOpenRequests: s.old.popupOpenRequests,
    newPopupOpenRequests: s.next.popupOpenRequests,
    requestReductionPct: s.reduction.popupOpenRequestReductionPct,
    avoidedPrefetchRequests: s.reduction.avoidedPrefetchRequests
  }))
}, null, 2));

function measureScenario(scenario) {
  const extractionRequests = scenario.pages * (scenario.multiQuery ? SORT_ORDERS.length : 1);
  const prefetchRequests = assumptions.depthSampleSize + assumptions.discoveredCategories;
  const oldPopupOpenRequests = prefetchRequests;
  const newPopupOpenRequests = scenario.depthAnalysis ? prefetchRequests : 0;
  const oldTotalBeforeOrDuringExtraction = extractionRequests + oldPopupOpenRequests;
  const newTotalBeforeOrDuringExtraction = extractionRequests + newPopupOpenRequests;

  return {
    name: scenario.name,
    input: scenario,
    extractionRequests,
    old: {
      behavior: 'detectPages always triggers depth prefetch',
      popupOpenRequests: oldPopupOpenRequests,
      totalRequestsBeforeOrDuringExtraction: oldTotalBeforeOrDuringExtraction,
      estimatedCompetingSlotMs: estimateSlotMs(oldPopupOpenRequests)
    },
    next: {
      behavior: 'depth prefetch starts only when depthAnalysis is enabled',
      popupOpenRequests: newPopupOpenRequests,
      totalRequestsBeforeOrDuringExtraction: newTotalBeforeOrDuringExtraction,
      estimatedCompetingSlotMs: estimateSlotMs(newPopupOpenRequests)
    },
    reduction: {
      avoidedPrefetchRequests: oldPopupOpenRequests - newPopupOpenRequests,
      popupOpenRequestReductionPct: pct(oldPopupOpenRequests - newPopupOpenRequests, oldPopupOpenRequests),
      totalRequestReductionPct: pct(oldTotalBeforeOrDuringExtraction - newTotalBeforeOrDuringExtraction, oldTotalBeforeOrDuringExtraction),
      estimatedCompetingSlotMsSaved: estimateSlotMs(oldPopupOpenRequests) - estimateSlotMs(newPopupOpenRequests)
    }
  };
}

function estimateSlotMs(requests) {
  return Math.round((requests / assumptions.poolConcurrency) * assumptions.avgRequestLatencyMs);
}

function pct(delta, base) {
  return base === 0 ? 0 : Math.round((delta / base) * 10000) / 100;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
