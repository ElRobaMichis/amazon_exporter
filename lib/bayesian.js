// ============================================================
// Bayesian Score Calculator
// Formula: BS = (v/(v+m)) × R + (m/(v+m)) × C
// ============================================================

/**
 * Calculate Bayesian Score for an array of products.
 *
 * @param {Array<Object>} products - Products from parser
 * @param {Object} [options]
 * @param {boolean} [options.filterSponsored=true] - Remove sponsored items
 * @param {number}  [options.minReviews=0] - Minimum reviews to include
 * @param {number}  [options.minPrice=0] - Minimum price filter
 * @param {number}  [options.maxPrice=Infinity] - Maximum price filter
 * @returns {Array<Object>} Scored and sorted products
 */
function calculateBayesScore(products, options = {}) {
  const {
    filterSponsored = true,
    minReviews = 0,
    minPrice = 0,
    maxPrice = Infinity
  } = options;

  // Step 1: Filter
  let filtered = products.filter(p => {
    if (filterSponsored && p.isSponsored) return false;
    if (p.reviewCount < minReviews) return false;
    if (p.price > 0 && (p.price < minPrice || p.price > maxPrice)) return false;
    if (p.rating === 0 || p.reviewCount === 0) return false;
    return true;
  });

  if (filtered.length === 0) return [];

  // Step 2: Calculate C (global average rating)
  let totalWeightedRating = 0;
  let totalReviews = 0;
  for (const p of filtered) {
    totalWeightedRating += p.rating * p.reviewCount;
    totalReviews += p.reviewCount;
  }
  const C = totalReviews > 0 ? totalWeightedRating / totalReviews : 0;

  // Step 3: Calculate m (percentile 25 of review counts)
  const reviewCounts = filtered.map(p => p.reviewCount).sort((a, b) => a - b);
  const p25Index = Math.floor(reviewCounts.length * 0.25);
  const m = reviewCounts[p25Index] || 1;

  // Step 4: Score each product
  const scored = filtered.map(p => {
    const v = p.reviewCount;
    const R = p.rating;
    const bayesScore = (v / (v + m)) * R + (m / (v + m)) * C;

    // Confidence: how much the score is driven by actual data vs prior
    const confidence = Math.round((v / (v + m)) * 100);

    return {
      ...p,
      bayesScore: Math.round(bayesScore * 1000) / 1000,
      confidence,
      // Metadata for transparency
      _bayes: { C: Math.round(C * 100) / 100, m, v, R }
    };
  });

  // Step 5: Sort by Bayesian Score descending
  scored.sort((a, b) => b.bayesScore - a.bayesScore);

  // Step 6: Add rank
  for (let i = 0; i < scored.length; i++) {
    scored[i].rank = i + 1;
  }

  return scored;
}

/**
 * Get summary statistics for a scored product set.
 */
function getSummaryStats(scored) {
  if (scored.length === 0) return null;
  const scores = scored.map(p => p.bayesScore);
  return {
    count: scored.length,
    avgScore: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100,
    maxScore: scores[0],
    minScore: scores[scores.length - 1],
    globalAvgRating: scored[0]._bayes.C,
    minimumThreshold: scored[0]._bayes.m
  };
}

/**
 * Export products to CSV string.
 */
function exportCSV(scored) {
  const headers = ['Rank', 'ASIN', 'Title', 'BayesScore', 'Rating', 'Reviews', 'Price', 'Currency', 'Discount%', 'Confidence%', 'Badge', 'URL'];
  const rows = scored.map(p => [
    p.rank,
    p.asin,
    `"${(p.title || '').replace(/"/g, '""')}"`,
    p.bayesScore,
    p.rating,
    p.reviewCount,
    p.price,
    p.currency,
    p.discount,
    p.confidence,
    `"${(p.badge || '').replace(/"/g, '""')}"`,
    p.productUrl
  ]);
  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}

/**
 * Export products to JSON string.
 */
function exportJSON(scored) {
  return JSON.stringify(scored.map(p => ({
    rank: p.rank,
    asin: p.asin,
    title: p.title,
    bayesScore: p.bayesScore,
    rating: p.rating,
    reviewCount: p.reviewCount,
    price: p.price,
    currency: p.currency,
    discount: p.discount,
    confidence: p.confidence,
    badge: p.badge,
    productUrl: p.productUrl,
    imageUrl: p.imageUrl
  })), null, 2);
}

// Export
if (typeof globalThis !== 'undefined') {
  globalThis.BayesBayesian = { calculateBayesScore, getSummaryStats, exportCSV, exportJSON };
}
