// bayes_selection.js - Handles Bayesian score selection after multi-page extraction
// VERSION: 3.2 - Added: keyword filter, pagination, export count badge
console.log('[BayesSelection] CODE VERSION 3.2 - Keyword filter + pagination');

let extractedProducts = [];
let productStats = {};
let currentMethod = 'enhanced';
let sampleProducts = [];

// Filter and pagination state
let keywordFilter = '';
let filteredProducts = [];
let displayLimit = 10;
const PAGE_SIZE = 10;

// Cached params for performance (calculated once, used many times)
let cachedParams = null;
let cachedEnhancedParams = null;
let cachedMaxReviews = 1;
let cachedRefPrice = 100; // 25th percentile price for value scoring

// Method descriptions for info panel
const methodDescriptions = {
  enhanced: {
    title: 'Bayesiano Mejorado',
    description: 'Usa el percentil 25 de reviews como umbral minimo y la mediana del rating. Los productos necesitan superar el 25% del dataset en reviews para obtener peso significativo. Ideal para datasets con grandes variaciones.'
  },
  wilson: {
    title: 'Wilson Score',
    description: 'Calcula el limite inferior del intervalo de confianza al 95%. Un producto con 4.5 estrellas y 500 resenas puntuara mas alto que uno con 5.0 estrellas y solo 5 resenas. Usado por Reddit para ranking.'
  },
  logadjusted: {
    title: 'Log-Ajustado',
    description: 'Combina el promedio bayesiano con un bonus logaritmico por cantidad de resenas. Favorece explicitamente productos populares. Ideal si buscas productos "buenos Y populares".'
  },
  classic: {
    title: 'Clasico',
    description: 'Formula bayesiana original usando promedios aritmeticos. Puede verse afectado por outliers (productos con muchas o pocas resenas). Incluye opcion de personalizar parametros.'
  },
  value: {
    title: 'Value Score',
    description: 'Calcula la relacion calidad-precio. Productos baratos con buena calidad obtienen scores mas altos. Ideal para encontrar ofertas. Nota: productos sin precio seran ocultados.'
  },
  premium: {
    title: 'Premium Score',
    description: 'Ajusta las expectativas de resenas segun el precio. Productos caros ($200+) necesitan menos resenas para puntuar bien. Ideal para evaluar productos de lujo. Nota: productos sin precio seran ocultados.'
  }
};

document.addEventListener('DOMContentLoaded', () => {
  console.log('[BayesSelection] Page loaded');

  // Load product data from storage
  chrome.storage.local.get(['extractedProducts'], (result) => {
    try {
      console.log('[BayesSelection] Storage result received');
      const count = result.extractedProducts?.length || 0;
      console.log('[BayesSelection] Products count:', count);

      if (result.extractedProducts && count > 0) {
        // Deduplicate products using ASIN as primary key, fallback to title
        const seen = new Set();
        extractedProducts = result.extractedProducts.filter(p => {
          const key = p.asin || p.title || '';
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        console.log(`[BayesSelection] Loaded ${count} products, ${extractedProducts.length} after deduplication`);

        // Use setTimeout to prevent blocking UI
        setTimeout(() => {
          try {
            initializePage();
          } catch (err) {
            console.error('[BayesSelection] Error in initializePage:', err);
            alert('Error al inicializar: ' + err.message);
          }
        }, 10);
      } else {
        console.error('[BayesSelection] No products found in storage');
        alert('No se encontraron productos extraidos.');
        window.close();
      }
    } catch (error) {
      console.error('[BayesSelection] Error loading products:', error);
      alert('Error al cargar los productos: ' + error.message);
    }
  });
});

function initializePage() {
  console.log('[BayesSelection] Initializing page...');

  // Calculate stats and cache params in one pass (efficient)
  calculateStatsAndCacheParams();

  // Select sample products (simple, fast)
  selectSampleProducts();

  // Setup UI
  setupEventListeners();

  // Generate preview
  generatePreview();

  console.log('[BayesSelection] Page initialized');
}

// Combined function: calculate stats and cache params in a SINGLE pass through the data
function calculateStatsAndCacheParams() {
  try {
    const n = extractedProducts.length;
    if (!n) return;

    console.log('[BayesSelection] Processing', n, 'products...');

    // Single pass to collect all needed values
    let sumRating = 0;
    let sumReviews = 0;
    let minReviews = Infinity;
    let maxReviews = 0;
    let validRatingCount = 0;

    const ratings = [];
    const reviewCounts = [];
    const prices = [];

    for (let i = 0; i < n; i++) {
      const p = extractedProducts[i];
      const rating = parseFloat(p.rating) || 0;
      const reviews = parseInt(p.reviews, 10) || 0;
      const price = parseFloat(p.price) || 0;

      if (rating > 0) {
        ratings.push(rating);
        sumRating += rating;
        validRatingCount++;
      }

      if (price > 0) {
        prices.push(price);
      }

      reviewCounts.push(reviews);
      sumReviews += reviews;

      if (reviews > 0 && reviews < minReviews) minReviews = reviews;
      if (reviews > maxReviews) maxReviews = reviews;
    }

    if (minReviews === Infinity) minReviews = 0;

    // Calculate stats
    const avgRating = validRatingCount > 0 ? sumRating / validRatingCount : 0;
    const avgReviews = n > 0 ? Math.round(sumReviews / n) : 0;

    productStats = {
      total: n,
      minReviews: minReviews,
      maxReviews: maxReviews,
      avgReviews: avgReviews,
      avgRating: avgRating.toFixed(2)
    };

    // Cache params for Bayesian calculations
    cachedParams = {
      C: avgRating || 3.5,
      m: avgReviews || 100
    };

    // Calculate enhanced params (need median and percentile)
    // For large datasets, use approximate methods
    if (n > 10000) {
      // Approximate: use average as fallback for very large datasets
      cachedEnhancedParams = {
        C: avgRating || 3.5,
        m: Math.max(avgReviews * 0.25, 10)
      };
    } else {
      // Sort copies for percentile/median (only for reasonable sizes)
      const sortedRatings = ratings.slice().sort((a, b) => a - b);
      const sortedReviews = reviewCounts.filter(r => r > 0).sort((a, b) => a - b);

      const medianRating = getMedianFromSorted(sortedRatings);
      const p25Reviews = getPercentileFromSorted(sortedReviews, 0.25);

      cachedEnhancedParams = {
        C: medianRating || 3.5,
        m: Math.max(p25Reviews, 10)
      };
    }

    cachedMaxReviews = maxReviews || 1;

    // Calculate 25th percentile price for value scoring (aggressively favors cheap products)
    if (prices.length > 0) {
      const sortedPrices = prices.slice().sort((a, b) => a - b);
      cachedRefPrice = Math.max(getPercentileFromSorted(sortedPrices, 0.25) || 100, 1);
    } else {
      cachedRefPrice = 100;
    }

    console.log('[BayesSelection] Stats:', productStats);
    console.log('[BayesSelection] Cached params:', cachedParams);
    console.log('[BayesSelection] Enhanced params:', cachedEnhancedParams);
    console.log('[BayesSelection] Reference price (25th percentile):', cachedRefPrice);

    // Display stats in UI
    document.getElementById('totalProducts').textContent = productStats.total.toLocaleString();
    document.getElementById('minReviews').textContent = productStats.minReviews.toLocaleString();
    document.getElementById('maxReviews').textContent = productStats.maxReviews.toLocaleString();
    document.getElementById('avgReviews').textContent = productStats.avgReviews.toLocaleString();
    document.getElementById('avgRating').textContent = productStats.avgRating;

    // Update header badge
    const headerCount = document.getElementById('headerProductCount');
    if (headerCount) {
      headerCount.textContent = productStats.total.toLocaleString();
    }

    // Update custom inputs
    document.getElementById('customC').value = productStats.avgRating;
    document.getElementById('customM').value = productStats.avgReviews;

  } catch (error) {
    console.error('[BayesSelection] Error calculating stats:', error);
  }
}

// Helper: get median from already sorted array
function getMedianFromSorted(sorted) {
  const len = sorted.length;
  if (!len) return 0;
  const mid = Math.floor(len / 2);
  return len % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Helper: get percentile from already sorted array
function getPercentileFromSorted(sorted, percentile) {
  const len = sorted.length;
  if (!len) return 0;
  const index = Math.floor(len * percentile);
  return sorted[Math.min(index, len - 1)];
}

function selectSampleProducts() {
  try {
    console.log('[BayesSelection] Selecting sample products');
    const n = extractedProducts.length;

    if (n <= 5) {
      sampleProducts = extractedProducts.slice(0, 5);
      return;
    }

    // Instead of sorting entire array, find specific products efficiently
    let bestRating = extractedProducts[0];
    let worstRating = extractedProducts[0];
    let mostReviews = extractedProducts[0];
    let leastReviews = extractedProducts[0];

    for (let i = 1; i < n; i++) {
      const p = extractedProducts[i];
      const rating = parseFloat(p.rating) || 0;
      const reviews = parseInt(p.reviews, 10) || 0;

      if (rating > (parseFloat(bestRating.rating) || 0)) bestRating = p;
      if (rating < (parseFloat(worstRating.rating) || 5)) worstRating = p;
      if (reviews > (parseInt(mostReviews.reviews, 10) || 0)) mostReviews = p;
      if (reviews > 0 && reviews < (parseInt(leastReviews.reviews, 10) || Infinity)) leastReviews = p;
    }

    // Get a middle product (approximate median)
    const middleIndex = Math.floor(n / 2);
    const middleProduct = extractedProducts[middleIndex];

    // Collect unique products (use title as identifier, not name)
    const candidates = [bestRating, mostReviews, middleProduct, leastReviews, worstRating];
    const seen = new Set();
    sampleProducts = [];

    for (const p of candidates) {
      const key = p?.title || p?.name || '';
      if (p && !seen.has(key)) {
        seen.add(key);
        sampleProducts.push(p);
      }
    }

    // Fill remaining slots if needed
    let idx = 0;
    while (sampleProducts.length < 5 && idx < n) {
      const p = extractedProducts[idx];
      const key = p?.title || p?.name || '';
      if (p && !seen.has(key)) {
        seen.add(key);
        sampleProducts.push(p);
      }
      idx++;
    }

    console.log('[BayesSelection] Sample products:', sampleProducts.length);
  } catch (error) {
    console.error('[BayesSelection] Error selecting samples:', error);
    sampleProducts = extractedProducts.slice(0, 5);
  }
}

function setupEventListeners() {
  try {
    // Method card selection
    document.querySelectorAll('.method-card').forEach(card => {
      card.addEventListener('click', () => {
        document.querySelectorAll('.method-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        currentMethod = card.dataset.method;

        const customInputs = document.getElementById('customInputs');
        customInputs.classList.toggle('visible', currentMethod === 'classic');

        updateMethodInfo(currentMethod);
        generatePreview();
      });
    });

    // Custom inputs change (debounced)
    let debounceTimer;
    const handleCustomInput = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (currentMethod === 'classic') {
          generatePreview();
        }
      }, 300);
    };

    document.getElementById('customC').addEventListener('input', handleCustomInput);
    document.getElementById('customM').addEventListener('input', handleCustomInput);

    // Keyword filter (debounced)
    let filterDebounceTimer;
    const keywordInput = document.getElementById('keywordFilter');
    if (keywordInput) {
      keywordInput.addEventListener('input', (e) => {
        clearTimeout(filterDebounceTimer);
        filterDebounceTimer = setTimeout(() => {
          keywordFilter = e.target.value.toLowerCase().trim();
          displayLimit = PAGE_SIZE; // Reset pagination when filter changes
          applyFilters();
          generatePreview();
          updateFilterHelp();
        }, 300);
      });
    }

    // Pagination buttons
    const showMoreBtn = document.getElementById('showMore');
    const showAllBtn = document.getElementById('showAll');

    if (showMoreBtn) {
      showMoreBtn.addEventListener('click', () => {
        displayLimit += PAGE_SIZE;
        generatePreview();
      });
    }

    if (showAllBtn) {
      showAllBtn.addEventListener('click', () => {
        displayLimit = Infinity;
        generatePreview();
      });
    }

    // Apply button
    document.getElementById('applyBayes').addEventListener('click', () => {
      applyBayesianScore(currentMethod);
    });

    // Cancel button
    document.getElementById('cancelBayes').addEventListener('click', () => {
      chrome.storage.local.remove(['extractedProducts']);
      window.close();
    });

  } catch (error) {
    console.error('[BayesSelection] Error setting up listeners:', error);
  }
}

function updateMethodInfo(method) {
  try {
    const info = methodDescriptions[method];
    const infoPanel = document.getElementById('methodInfo');
    const titleEl = infoPanel.querySelector('.method-info-content h5');
    const descEl = infoPanel.querySelector('.method-info-content p');
    if (titleEl) titleEl.textContent = info.title;
    if (descEl) descEl.textContent = info.description;
  } catch (error) {
    console.error('[BayesSelection] Error updating method info:', error);
  }
}

// Filter products by keyword (AND logic for multiple words)
function applyFilters() {
  if (!keywordFilter) {
    filteredProducts = [...extractedProducts];
    return;
  }

  const keywords = keywordFilter.split(/\s+/).filter(k => k.length > 0);

  filteredProducts = extractedProducts.filter(product => {
    const title = (product.title || product.name || '').toLowerCase();
    return keywords.every(keyword => title.includes(keyword));
  });
}

// Update filter help text
function updateFilterHelp() {
  const helpEl = document.getElementById('filterHelp');
  const helpText = document.getElementById('filterHelpText');

  if (keywordFilter) {
    helpEl.classList.add('visible');
    if (filteredProducts.length === 0) {
      helpEl.classList.add('no-results');
      helpText.textContent = `Sin resultados para "${keywordFilter}"`;
    } else {
      helpEl.classList.remove('no-results');
      helpText.textContent = `${filteredProducts.length} de ${extractedProducts.length} productos`;
    }
  } else {
    helpEl.classList.remove('visible', 'no-results');
  }
}

// Update export count badge
function updateExportCount(count) {
  const badge = document.getElementById('exportCount');
  if (badge) {
    badge.textContent = count.toLocaleString();
  }
}

// Update pagination controls visibility
function updatePaginationControls(showingCount, totalCount) {
  const showMoreBtn = document.getElementById('showMore');
  const showAllBtn = document.getElementById('showAll');
  const showingEl = document.getElementById('showingCount');
  const totalEl = document.getElementById('totalFilteredCount');

  if (showingEl) showingEl.textContent = showingCount;
  if (totalEl) totalEl.textContent = totalCount;

  // Hide buttons if all products are shown
  const allShown = showingCount >= totalCount;
  if (showMoreBtn) showMoreBtn.style.display = allShown ? 'none' : '';
  if (showAllBtn) showAllBtn.style.display = allShown ? 'none' : '';
}

function getScoreColor(score) {
  const numScore = parseFloat(score);
  if (numScore >= 4.5) return 'var(--score-excellent)';
  if (numScore >= 4.0) return 'var(--score-good)';
  if (numScore >= 3.5) return 'var(--score-average)';
  if (numScore >= 3.0) return 'var(--score-fair)';
  return 'var(--score-poor)';
}

function generatePreview() {
  const previewBody = document.getElementById('previewBody');

  try {
    // Apply filters if not already done
    if (filteredProducts.length === 0 && extractedProducts.length > 0) {
      applyFilters();
    }

    if (!extractedProducts.length) {
      previewBody.innerHTML = '<tr><td colspan="6" style="text-align: center;">No hay productos</td></tr>';
      updatePaginationControls(0, 0);
      updateExportCount(0);
      return;
    }

    if (!cachedParams) {
      previewBody.innerHTML = '<tr><td colspan="6" style="text-align: center;">Calculando...</td></tr>';
      return;
    }

    // Handle empty filter results
    if (filteredProducts.length === 0 && keywordFilter) {
      previewBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No hay productos que coincidan con el filtro</td></tr>';
      updatePaginationControls(0, 0);
      updateExportCount(0);
      return;
    }

    // Get custom params if classic method
    let customParams = null;
    if (currentMethod === 'classic') {
      customParams = {
        C: parseFloat(document.getElementById('customC').value) || 3.5,
        m: parseInt(document.getElementById('customM').value) || 100
      };
    }

    // Check if current method uses price (to highlight price column)
    const isPriceMethod = currentMethod === 'value' || currentMethod === 'premium';

    // Calculate scores for filtered products
    let allProductsWithScore = filteredProducts.map(product => {
      const score = calculateScoreInline(product, currentMethod, customParams);
      return {
        name: product.title || product.name || 'Sin nombre',
        link: product.link || '',
        rating: parseFloat(product.rating) || 0,
        reviews: parseInt(product.reviews, 10) || 0,
        price: parseFloat(product.price) || 0,
        score: score
      };
    });

    // For price-based methods, filter out products without valid price
    if (isPriceMethod) {
      allProductsWithScore = allProductsWithScore.filter(p => p.price > 0);
    }

    // For value method, normalize scores to 0-5 range (prevents all scores capping at 5.0)
    if (currentMethod === 'value' && allProductsWithScore.length > 0) {
      const scores = allProductsWithScore.map(p => parseFloat(p.score));
      const minScore = Math.min(...scores);
      const maxScore = Math.max(...scores);
      const range = maxScore - minScore || 1;

      allProductsWithScore = allProductsWithScore.map(p => ({
        ...p,
        score: (((parseFloat(p.score) - minScore) / range) * 5).toFixed(3)
      }));
    }

    // Count products without price for info message
    const productsWithoutPrice = filteredProducts.filter(p => !(parseFloat(p.price) > 0)).length;

    // Sort by score descending, with tie-breaking by reviews and rating
    allProductsWithScore.sort((a, b) => {
      // Primary: score descending
      const scoreDiff = parseFloat(b.score) - parseFloat(a.score);
      if (scoreDiff !== 0) return scoreDiff;

      // Secondary: reviews descending (more reviews = more trusted)
      const reviewsDiff = b.reviews - a.reviews;
      if (reviewsDiff !== 0) return reviewsDiff;

      // Tertiary: rating descending
      return b.rating - a.rating;
    });

    // Apply pagination
    const totalCount = allProductsWithScore.length;
    const previewData = allProductsWithScore.slice(0, displayLimit);
    const showingCount = previewData.length;

    // Update pagination controls
    updatePaginationControls(showingCount, totalCount);

    // Update export count (total filtered, not just showing)
    updateExportCount(totalCount);

    // Update preview note
    const previewNote = document.getElementById('previewNote');
    if (previewNote) {
      let noteText = `Top ${showingCount} por Bayescore`;
      if (isPriceMethod && productsWithoutPrice > 0) {
        noteText += ` (${productsWithoutPrice} sin precio ocultos)`;
        previewNote.style.color = 'var(--primary-dark)';
      } else {
        previewNote.style.color = '';
      }
      previewNote.textContent = noteText;
    }

    // Generate HTML
    previewBody.innerHTML = previewData.map(product => {
      const scoreNum = parseFloat(product.score);
      const scorePercent = (scoreNum / 5) * 100;
      const scoreColor = getScoreColor(product.score);
      const priceDisplay = product.price > 0 ? `$${product.price.toFixed(2)}` : '-';
      const priceClass = isPriceMethod ? 'price-cell highlight' : 'price-cell';

      return `
        <tr>
          <td class="product-name" title="${escapeHtml(product.name)}">${escapeHtml(truncate(product.name, 25))}</td>
          <td class="link-cell">${product.link ? `<a href="${escapeHtml(product.link)}" target="_blank" rel="noopener">Ver</a>` : '-'}</td>
          <td class="rating-cell">${product.rating.toFixed(1)}</td>
          <td class="reviews-cell">${product.reviews.toLocaleString()}</td>
          <td class="${priceClass}">${priceDisplay}</td>
          <td>
            <div class="score-display">
              <span class="score-value" style="color: ${scoreColor}">${product.score}</span>
              <div class="score-bar">
                <div class="score-fill" style="width: ${scorePercent}%; background: ${scoreColor}"></div>
              </div>
            </div>
          </td>
        </tr>
      `;
    }).join('');

  } catch (error) {
    console.error('[BayesSelection] Error generating preview:', error);
    previewBody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: red;">Error: ${escapeHtml(error.message)}</td></tr>`;
  }
}

// Helper: Get price tier for inline calculation
function getPriceTierInline(price) {
  const p = parseFloat(price);
  if (isNaN(p) || p <= 0) return { tier: 'budget', multiplier: 1.0 };
  if (p <= 50) return { tier: 'budget', multiplier: 1.0 };
  if (p <= 200) return { tier: 'midrange', multiplier: 0.7 };
  if (p <= 500) return { tier: 'premium', multiplier: 0.5 };
  return { tier: 'luxury', multiplier: 0.3 };
}

// Inline score calculation - no external dependencies, uses cached params
function calculateScoreInline(product, method, customParams) {
  const rating = parseFloat(product.rating) || 0;
  const reviews = parseInt(product.reviews, 10) || 0;
  const price = parseFloat(product.price) || 0;

  switch (method) {
    case 'wilson': {
      if (reviews === 0) return '0.000';
      const z = 1.96;
      const phat = rating / 5;
      const n = reviews;
      const denominator = 1 + (z * z) / n;
      const center = phat + (z * z) / (2 * n);
      const spread = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);
      const lowerBound = (center - spread) / denominator;
      return (lowerBound * 5).toFixed(3);
    }

    case 'logadjusted': {
      const { C, m } = cachedParams;
      const bayesian = ((reviews / (reviews + m)) * rating + (m / (reviews + m)) * C) || 0;
      const reviewBonus = reviews > 0 ? 0.5 * (Math.log10(reviews + 1) / Math.log10(cachedMaxReviews + 1)) : 0;
      return Math.min(5, bayesian + reviewBonus).toFixed(3);
    }

    case 'enhanced': {
      const { C, m } = cachedEnhancedParams;
      // Base Bayesian score
      const bayesian = ((reviews / (reviews + m)) * rating + (m / (reviews + m)) * C) || 0;

      // Rating quality multiplier: penalizes ratings below 3.0
      let ratingMultiplier = 1.0;
      if (rating < 3.0) {
        ratingMultiplier = Math.pow(rating / 3, 2);
      }

      // Confidence factor: products with very few reviews (< 5) get reduced score
      let confidenceFactor = 1.0;
      if (reviews < 5) {
        confidenceFactor = 0.5 + (reviews / 10);
      }

      // Final score: Bayesian × rating quality × confidence
      const finalScore = bayesian * ratingMultiplier * confidenceFactor;
      return Math.max(0, Math.min(5, finalScore)).toFixed(3);
    }

    case 'value': {
      const { C, m } = cachedEnhancedParams;
      // Currency-agnostic: use 25th percentile price as reference (favors cheap products)
      const refPrice = cachedRefPrice || 100;
      const refOffset = refPrice * 0.1;

      // Base quality: Enhanced Bayesian score
      const bayesian = ((reviews / (reviews + m)) * rating + (m / (reviews + m)) * C) || 0;

      // Rating quality multiplier
      let ratingMultiplier = 1.0;
      if (rating < 3.0) {
        ratingMultiplier = Math.pow(rating / 3, 2);
      }

      // Confidence factor
      let confidenceFactor = 1.0;
      if (reviews < 5) {
        confidenceFactor = 0.5 + (reviews / 10);
      }

      // Review volume bonus: reward products with many reviews (proven popularity)
      const reviewBonus = reviews > 0
        ? 1 + 0.3 * (Math.log10(reviews + 1) / Math.log10(cachedMaxReviews + 1))
        : 1;

      const quality = bayesian * ratingMultiplier * confidenceFactor * reviewBonus;

      // Value calculation - cheaper products get a boost
      if (price <= 0) {
        return Math.max(0, Math.min(5, quality)).toFixed(3);
      }

      // Price adjustment: return RAW score (will be normalized later in generatePreview)
      const priceRatio = refPrice / (price + refOffset);
      const priceAdjustment = Math.log(priceRatio) * 0.8;
      const valueScore = quality + priceAdjustment;
      // Don't cap here - normalization happens in generatePreview
      return valueScore.toFixed(3);
    }

    case 'premium': {
      const { C, m } = cachedEnhancedParams;
      const tier = getPriceTierInline(price);
      const adjustedM = m * tier.multiplier;

      // Bayesian with adjusted m - expensive products need fewer reviews
      const bayesian = ((reviews / (reviews + adjustedM)) * rating + (adjustedM / (reviews + adjustedM)) * C) || 0;

      // Rating quality multiplier
      let ratingMultiplier = 1.0;
      if (rating < 3.0) {
        ratingMultiplier = Math.pow(rating / 3, 2);
      }

      // Confidence threshold adjusts by price tier
      let confidenceThreshold = 5;
      if (tier.tier === 'premium' || tier.tier === 'midrange') confidenceThreshold = 3;
      if (tier.tier === 'luxury') confidenceThreshold = 2;

      let confidenceFactor = 1.0;
      if (reviews < confidenceThreshold) {
        confidenceFactor = 0.5 + (reviews / (confidenceThreshold * 2));
      }

      const finalScore = bayesian * ratingMultiplier * confidenceFactor;
      return Math.max(0, Math.min(5, finalScore)).toFixed(3);
    }

    case 'custom': {
      const { C, m } = customParams || { C: 3.5, m: 100 };
      const score = ((reviews / (reviews + m)) * rating + (m / (reviews + m)) * C) || 0;
      return score.toFixed(3);
    }

    case 'classic':
    default: {
      const { C, m } = cachedParams;
      const score = ((reviews / (reviews + m)) * rating + (m / (reviews + m)) * C) || 0;
      return score.toFixed(3);
    }
  }
}

function truncate(str, maxLength) {
  if (!str) return '';
  return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function applyBayesianScore(method) {
  try {
    if (!extractedProducts.length) {
      alert('No hay productos para exportar.');
      return;
    }

    console.log('[BayesSelection] Applying scores with method:', method);

    // Get custom params if needed
    let customParams = null;
    if (method === 'classic') {
      customParams = {
        C: parseFloat(document.getElementById('customC').value) || 3.5,
        m: parseInt(document.getElementById('customM').value) || 100
      };
    }

    // Check if this is a price-based method
    const isPriceMethod = method === 'value' || method === 'premium';

    // Start with filtered products if keyword filter is active, otherwise use all
    let productsToExport = keywordFilter ? [...filteredProducts] : [...extractedProducts];

    if (keywordFilter) {
      console.log(`[BayesSelection] Exporting ${productsToExport.length} filtered products (keyword: "${keywordFilter}")`);
    }

    // Filter products for price-based methods
    if (isPriceMethod) {
      const beforeCount = productsToExport.length;
      productsToExport = productsToExport.filter(p => parseFloat(p.price) > 0);
      const filtered = beforeCount - productsToExport.length;
      if (filtered > 0) {
        console.log(`[BayesSelection] Filtered ${filtered} products without price`);
      }
    }

    // Apply scores to products
    for (let i = 0; i < productsToExport.length; i++) {
      productsToExport[i].bayescore = calculateScoreInline(productsToExport[i], method, customParams);
    }

    // Check if csvUtils is available
    if (typeof csvUtils === 'undefined') {
      alert('Error: csvUtils no disponible.');
      return;
    }

    // Deduplicate and export
    const unique = csvUtils.deduplicate(productsToExport);
    console.log('[BayesSelection] Unique products:', unique.length);

    const csv = csvUtils.toCsv(unique);

    if (typeof downloadUtils === 'undefined') {
      alert('Error: downloadUtils no disponible.');
      return;
    }

    downloadUtils.downloadCsv(csv, 'amazon_all_products.csv');

    // Cleanup
    chrome.storage.local.remove(['extractedProducts']);

    setTimeout(() => window.close(), 500);

  } catch (error) {
    console.error('[BayesSelection] Error applying score:', error);
    alert('Error: ' + error.message);
  }
}
