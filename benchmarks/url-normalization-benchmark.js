#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, 'results');
const SORT_ORDERS = ['', '&s=review-rank', '&s=price-asc-rank', '&s=price-desc-rank', '&s=date-desc-rank'];

const scenarios = [
  {
    name: 'plain-search-multi',
    url: 'https://www.amazon.com.mx/s?k=mouse&page=2',
    multiQuery: true,
    pages: 7
  },
  {
    name: 'sorted-search-multi',
    url: 'https://www.amazon.com.mx/s?k=mouse&s=review-rank&page=2',
    multiQuery: true,
    pages: 7
  },
  {
    name: 'sorted-search-normal',
    url: 'https://www.amazon.com.mx/s?k=mouse&s=review-rank&page=2',
    multiQuery: false,
    pages: 7
  }
].map(measureScenario);

const result = {
  benchmark: 'url-normalization',
  timestamp: new Date().toISOString(),
  method: 'Local URL task generation check for normal/multi-query modes.',
  scenarios,
  conclusion: {
    change: 'Delete page always and delete existing s= only when multiQuery owns sort expansion.',
    normalModeSortPreserved: true,
    multiQueryDuplicateSortsAvoided: true
  }
};

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const outPath = path.join(RESULTS_DIR, `url-normalization-${stamp()}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log(JSON.stringify({
  saved: outPath,
  scenarios: scenarios.map((s) => ({
    name: s.name,
    oldDuplicateSortUrls: s.old.duplicateSortUrls,
    nextDuplicateSortUrls: s.next.duplicateSortUrls,
    oldUniqueTasks: s.old.uniqueTasks,
    nextUniqueTasks: s.next.uniqueTasks
  }))
}, null, 2));

function measureScenario(scenario) {
  const oldTasks = buildTasks(oldBaseUrl(scenario.url), scenario.pages, scenario.multiQuery);
  const nextTasks = buildTasks(normalizeSearchBaseUrl(scenario.url, scenario.multiQuery), scenario.pages, scenario.multiQuery);
  return {
    name: scenario.name,
    input: scenario,
    old: summarize(oldTasks),
    next: summarize(nextTasks)
  };
}

function buildTasks(baseUrl, pages, multiQuery) {
  const sortOrders = multiQuery ? SORT_ORDERS : [''];
  const tasks = [];
  for (let si = 0; si < sortOrders.length; si++) {
    for (let page = 1; page <= pages; page++) {
      const sep = baseUrl.indexOf('?') !== -1 ? '&' : '?';
      tasks.push(baseUrl + sep + 'page=' + page + sortOrders[si]);
    }
  }
  return tasks;
}

function oldBaseUrl(url) {
  return url.split('&page=')[0].split('?page=')[0];
}

function normalizeSearchBaseUrl(rawUrl, removeSort) {
  const url = new URL(rawUrl);
  url.searchParams.delete('page');
  if (removeSort) url.searchParams.delete('s');
  return url.toString();
}

function summarize(tasks) {
  return {
    totalTasks: tasks.length,
    uniqueTasks: new Set(tasks).size,
    duplicateSortUrls: tasks.filter((task) => countSortParams(task) > 1).length,
    sample: tasks.slice(0, Math.min(5, tasks.length))
  };
}

function countSortParams(task) {
  return (task.match(/[?&]s=/g) || []).length;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
