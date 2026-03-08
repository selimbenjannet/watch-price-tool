const fetch = require('node-fetch');
const cheerio = require('cheerio');

// ═══════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const BROWSERLESS_URL = process.env.BROWSERLESS_URL || 'https://production-sfo.browserless.io';

// Browser-like headers to avoid 403 blocks
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
};

// Tudor-specific headers with France country cookie
const TUDOR_HEADERS = {
  ...HEADERS,
  'Cookie': 'country=FR; selectedCountry=FR; userCountry=FR; region=FR; locale=fr_FR',
};


// ═══════════════════════════════════════════════════════════
// PHASE 1: Direct HTTP fetch (fast, free, sometimes blocked)
// ═══════════════════════════════════════════════════════════

// ─── Chopard: SFCC API (confirmed working — no fallback needed) ───
async function getChopardPrice(ref) {
  const url = `https://www.chopard.com/on/demandware.store/Sites-chopard-Site/fr_FR/Product-Variation?pid=${encodeURIComponent(ref)}&format=ajax`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(url, {
      headers: {
        ...HEADERS,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const data = await res.json();

    if (data?.product?.price?.sales?.value) {
      return {
        price: data.product.price.sales.value,
        currency: 'EUR',
        name: data.product.productName || ref,
      };
    }
    if (data?.product?.gtmData?.price) {
      return {
        price: parseFloat(data.product.gtmData.price),
        currency: 'EUR',
        name: data.product.gtmData.name || ref,
      };
    }
    return null;
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

// ─── Race helper: first success or null after timeout ───
async function raceWithTimeout(promises, timeoutMs) {
  return Promise.race([
    Promise.any(promises).catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

// ─── Generic fetch + extract price ───
async function tryFetchPrice(url, brand, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const price = extractPriceFromHTML(html, brand);
    if (price) {
      const name = extractNameFromHTML(html) || null;
      return { price, currency: 'EUR', name };
    }
    throw new Error('No price found');
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// ─── Tudor-specific fetch with country cookie ───
async function tryFetchPriceTudor(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: TUDOR_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const price = extractPriceFromHTML(html, 'tudor');
    if (price) {
      const name = extractNameFromHTML(html) || null;
      return { price, currency: 'EUR', name };
    }
    throw new Error('No price found');
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// ─── Longines: parallel collection URLs (Phase 1) ───
const LONGINES_COLLECTIONS = [
  'hydroconquest', 'master-collection', 'spirit', 'conquest',
  'elegant-collection', 'dolcevita', 'heritage-classic',
  'la-grande-classique-de-longines', 'record', 'flagship',
  'primaluna', 'symphonette', 'mini-dolcevita',
  'longines-spirit', 'heritage-military', 'legend-diver',
  'ultra-chron', 'pilot', 'skin-diver',
];

async function getLonginesPrice(ref) {
  const refFormatted = ref.toLowerCase().replace(/\./g, '-');
  const attempts = LONGINES_COLLECTIONS.map(collection => {
    const url = `https://www.longines.com/fr/p/watch-${collection}-${refFormatted}`;
    return tryFetchPrice(url, 'longines');
  });
  attempts.push(
    tryFetchPrice(`https://api.ecom.longines.com/fr/search?q=${encodeURIComponent(ref)}`, 'longines')
  );
  // 3s timeout for Phase 1 (leaves room for Phase 2)
  const result = await raceWithTimeout(attempts, 3000);
  if (result) return { ...result, name: result.name || ref };
  return null;
}

// ─── Tudor: parallel family URLs (Phase 1) ───
const TUDOR_FAMILIES = [
  'daring-watches', 'black-bay', 'black-bay-chrono',
  'pelagos', 'pelagos-fxd', 'tudor-royal',
  '1926', 'ranger', 'glamour-date',
];

async function getTudorPrice(ref) {
  const refFormatted = ref.toLowerCase();
  const attempts = TUDOR_FAMILIES.map(family => {
    const url = `https://www.tudorwatch.com/en/watch-family/${family}/${refFormatted}`;
    return tryFetchPriceTudor(url);
  });
  const oldFamilies = ['black-bay', 'pelagos', 'royal', '1926', 'ranger'];
  oldFamilies.forEach(collection => {
    attempts.push(
      tryFetchPriceTudor(`https://www.tudorwatch.com/en/watches/${collection}/${refFormatted}`)
    );
  });
  // 3s timeout for Phase 1
  const result = await raceWithTimeout(attempts, 3000);
  if (result) return { ...result, name: result.name || ref };
  return null;
}

// ─── Hublot: search-based approach (Phase 1) ───
async function getHublotPrice(ref) {
  const refSlug = ref.toLowerCase().replace(/\./g, '-');
  const attempts = [
    tryFetchPrice(`https://www.hublot.com/fr-fr/find-your-hublot?query=${encodeURIComponent(ref)}`, 'hublot'),
    tryFetchPrice(`https://www.hublot.com/fr-fr/watches/${refSlug}`, 'hublot'),
  ];
  // 3s timeout for Phase 1
  const result = await raceWithTimeout(attempts, 3000);
  if (result) return { ...result, name: result.name || ref };
  return null;
}


// ═══════════════════════════════════════════════════════════
// PHASE 2: Browserless.io headless browser (reliable fallback)
// ═══════════════════════════════════════════════════════════

/**
 * Fetch fully-rendered HTML via Browserless.io headless Chrome.
 * The /content endpoint loads the page, executes JavaScript, and returns HTML.
 */
async function fetchRenderedHTML(url, options = {}) {
  if (!BROWSERLESS_TOKEN) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);

  try {
    const body = {
      url,
      gotoOptions: {
        waitUntil: 'networkidle0',
        timeout: 5500,
      },
    };

    // Set cookies (e.g., country=FR for Tudor)
    if (options.cookies && options.cookies.length > 0) {
      body.cookies = options.cookies;
    }

    // Optional: wait for a specific element to appear
    if (options.waitForSelector) {
      body.waitForSelector = {
        selector: options.waitForSelector,
        timeout: 4000,
      };
    }

    const res = await fetch(`${BROWSERLESS_URL}/content?token=${BROWSERLESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.log(`[browserless] HTTP ${res.status} for ${url}`);
      return null;
    }

    return await res.text();
  } catch (e) {
    clearTimeout(timeout);
    console.log(`[browserless] Error: ${e.message}`);
    return null;
  }
}

/**
 * Phase 2 dispatcher: try Browserless.io for each brand
 */
async function getBrowserlessPrice(brand, ref) {
  if (!BROWSERLESS_TOKEN) return null;

  console.log(`[browserless] Phase 2 — trying ${brand} ref: ${ref}`);

  switch (brand) {
    case 'longines': return getBrowserlessLonginesPrice(ref);
    case 'tudor':    return getBrowserlessTudorPrice(ref);
    case 'hublot':   return getBrowserlessHublotPrice(ref);
    default:         return null;
  }
}

// ─── Longines via Browserless ───
async function getBrowserlessLonginesPrice(ref) {
  const refFormatted = ref.toLowerCase().replace(/\./g, '-');

  // Strategy A: Try the search page (rendered with JS)
  const searchHtml = await fetchRenderedHTML(
    `https://www.longines.com/fr/search?q=${encodeURIComponent(ref)}`
  );
  if (searchHtml) {
    const price = extractPriceFromHTML(searchHtml, 'longines');
    if (price) {
      return { price, currency: 'EUR', name: extractNameFromHTML(searchHtml) || ref };
    }
  }

  // Strategy B: Try most common collections with Browserless
  const commonCollections = ['hydroconquest', 'master-collection', 'spirit', 'conquest', 'legend-diver'];
  const attempts = commonCollections.map(collection => {
    const url = `https://www.longines.com/fr/p/watch-${collection}-${refFormatted}`;
    return fetchRenderedHTML(url).then(html => {
      if (!html) throw new Error('No HTML');
      const price = extractPriceFromHTML(html, 'longines');
      if (!price) throw new Error('No price');
      return { price, currency: 'EUR', name: extractNameFromHTML(html) || ref };
    });
  });

  return Promise.any(attempts).catch(() => null);
}

// ─── Tudor via Browserless ───
async function getBrowserlessTudorPrice(ref) {
  const refLower = ref.toLowerCase();

  // France cookies so Tudor shows EUR prices
  const cookies = [
    { name: 'country', value: 'FR', domain: '.tudorwatch.com', path: '/' },
    { name: 'selectedCountry', value: 'FR', domain: '.tudorwatch.com', path: '/' },
    { name: 'userCountry', value: 'FR', domain: '.tudorwatch.com', path: '/' },
    { name: 'region', value: 'FR', domain: '.tudorwatch.com', path: '/' },
    { name: 'locale', value: 'fr_FR', domain: '.tudorwatch.com', path: '/' },
  ];

  // Guess the most likely families from reference prefix
  const families = guessTudorFamilies(ref);

  // Try guessed families in parallel — first success wins
  const attempts = families.map(family => {
    const url = `https://www.tudorwatch.com/en/watch-family/${family}/${refLower}`;
    return fetchRenderedHTML(url, { cookies }).then(html => {
      if (!html) throw new Error('No HTML');
      const price = extractPriceFromHTML(html, 'tudor');
      if (!price) throw new Error('No price');
      return { price, currency: 'EUR', name: extractNameFromHTML(html) || ref };
    });
  });

  return Promise.any(attempts).catch(() => null);
}

/**
 * Guess Tudor family from reference number prefix.
 * Returns 2-3 most likely families to minimize Browserless API calls.
 */
function guessTudorFamilies(ref) {
  const clean = ref.toUpperCase().replace(/^M/, '');

  if (/^79[0-3]/.test(clean)) return ['black-bay', 'black-bay-chrono', 'ranger'];
  if (/^79[4-9]/.test(clean)) return ['black-bay', 'daring-watches'];
  if (/^25/.test(clean))       return ['pelagos', 'pelagos-fxd'];
  if (/^28/.test(clean))       return ['tudor-royal'];
  if (/^91/.test(clean))       return ['1926'];

  // Unknown prefix: try most popular families
  return ['black-bay', 'pelagos', 'tudor-royal'];
}

// ─── Hublot via Browserless ───
async function getBrowserlessHublotPrice(ref) {
  // Try Hublot search page (rendered with JS)
  const html = await fetchRenderedHTML(
    `https://www.hublot.com/fr-fr/find-your-hublot?query=${encodeURIComponent(ref)}`
  );
  if (html) {
    const price = extractPriceFromHTML(html, 'hublot');
    if (price) {
      return { price, currency: 'EUR', name: extractNameFromHTML(html) || ref };
    }
  }

  // Try direct product URL
  const refSlug = ref.toLowerCase().replace(/\./g, '-');
  const directHtml = await fetchRenderedHTML(
    `https://www.hublot.com/fr-fr/watches/${refSlug}`
  );
  if (directHtml) {
    const price = extractPriceFromHTML(directHtml, 'hublot');
    if (price) {
      return { price, currency: 'EUR', name: extractNameFromHTML(directHtml) || ref };
    }
  }

  return null;
}


// ═══════════════════════════════════════════════════════════
// Price & name extraction from HTML
// ═══════════════════════════════════════════════════════════

function extractPriceFromHTML(html, brand) {
  const $ = cheerio.load(html);

  // Strategy 1: JSON-LD structured data (fixed: .each() can't return)
  let jsonLdPrice = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (jsonLdPrice) return false; // stop iterating
    try {
      const data = JSON.parse($(el).html());
      const offers = data.offers || data.Offers ||
        (data['@graph'] && data['@graph'].find(n => n.offers))?.offers;
      if (offers) {
        const price = offers.price || (offers[0] && offers[0].price);
        if (price) jsonLdPrice = parseFloat(price);
      }
    } catch (e) {}
  });
  if (jsonLdPrice && jsonLdPrice > 0 && jsonLdPrice < 1000000) return jsonLdPrice;

  // Strategy 2: dataLayer / GTM ecommerce data
  const dataLayerMatch = html.match(/["']price["']\s*:\s*["']?([\d.,]+)["']?/);
  if (dataLayerMatch) {
    const price = parseFloat(dataLayerMatch[1].replace(',', ''));
    if (price > 0 && price < 1000000) return price;
  }

  // Strategy 3: meta tags
  const metaPrice = $('meta[property="product:price:amount"]').attr('content') ||
                    $('meta[property="og:price:amount"]').attr('content');
  if (metaPrice) {
    const p = parseFloat(metaPrice);
    if (p > 0 && p < 1000000) return p;
  }

  // Strategy 4: Common price CSS selectors
  const priceSelectors = [
    '.product-price', '.price', '.product__price', '.pdp-price',
    '[data-price]', '.current-price', '.sales-price', '.offer-price',
    '.price-value', '.price--current', '.product-detail__price',
  ];
  for (const sel of priceSelectors) {
    const el = $(sel).first();
    if (el.length) {
      const text = el.text().replace(/[^\d.,]/g, '').replace(',', '.');
      const price = parseFloat(text);
      if (price > 0 && price < 1000000) return price;
    }
  }

  // Strategy 5: Regex — €/EUR followed by amount
  const eurMatch = html.match(/(?:€|EUR)\s*([\d\s.,]+)/);
  if (eurMatch) {
    const price = parseFloat(eurMatch[1].replace(/[\s,]/g, '').replace(',', '.'));
    if (price > 0 && price < 1000000) return price;
  }

  // Strategy 6: Regex — amount followed by €/EUR
  const priceEurMatch = html.match(/([\d\s.,]+)\s*(?:€|EUR)/);
  if (priceEurMatch) {
    const price = parseFloat(priceEurMatch[1].replace(/[\s,]/g, '').replace(',', '.'));
    if (price > 0 && price < 1000000) return price;
  }

  return null;
}

function extractNameFromHTML(html) {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim();
  if (title) return title;
  const ogTitle = $('meta[property="og:title"]').attr('content');
  if (ogTitle) return ogTitle;
  return null;
}


// ═══════════════════════════════════════════════════════════
// Brand detection & fallback URLs
// ═══════════════════════════════════════════════════════════

function detectBrand(ref) {
  ref = ref.trim().toUpperCase();
  if (/^L\d/.test(ref)) return 'longines';
  if (/^M\d{3,}/.test(ref)) return 'tudor';
  if (/^\d{5}/.test(ref) && !ref.includes('.')) return 'tudor';
  if (/^\d{3}\.\w{2}\.\d{3,4}\.\w{2}/.test(ref)) return 'hublot';
  if (/^\d{5,}/.test(ref)) return 'chopard';
  return null;
}

function getFallbackUrl(brand, ref) {
  const encoded = encodeURIComponent(ref);
  switch (brand) {
    case 'chopard':
      return `https://www.chopard.com/fr-fr/search?q=${encoded}`;
    case 'longines':
      return `https://www.google.com/search?q=site:longines.com/fr+"${encoded}"`;
    case 'tudor':
      return `https://www.google.com/search?q=site:tudorwatch.com+"${encoded}"`;
    case 'hublot':
      return `https://www.google.com/search?q=Hublot+"${encoded}"+prix+EUR+france`;
    default:
      return `https://www.google.com/search?q="${encoded}"+prix+EUR+france`;
  }
}


// ═══════════════════════════════════════════════════════════
// Main API handler
// ═══════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { ref, brand: brandParam } = req.query;

  if (!ref) {
    return res.status(400).json({ error: 'Missing reference number (ref)' });
  }

  const brand = brandParam || detectBrand(ref);

  if (!brand) {
    return res.status(400).json({
      error: 'Could not detect brand. Please specify brand parameter.',
      detectedBrand: null,
    });
  }

  console.log(`[price] Looking up ${brand} ref: ${ref}`);

  let result = null;
  let source = null;

  // ── Phase 1: Direct HTTP fetch (fast, free) ──
  try {
    switch (brand) {
      case 'chopard':  result = await getChopardPrice(ref); break;
      case 'longines': result = await getLonginesPrice(ref); break;
      case 'tudor':    result = await getTudorPrice(ref);    break;
      case 'hublot':   result = await getHublotPrice(ref);   break;
      default:
        return res.status(400).json({ error: `Unknown brand: ${brand}` });
    }
    if (result) source = 'direct';
  } catch (e) {
    console.error(`[price] Phase 1 error for ${brand}/${ref}:`, e.message);
  }

  // ── Phase 2: Browserless.io headless browser (fallback) ──
  if (!result && brand !== 'chopard') {
    try {
      result = await getBrowserlessPrice(brand, ref);
      if (result) source = 'browserless';
    } catch (e) {
      console.error(`[price] Phase 2 error for ${brand}/${ref}:`, e.message);
    }
  }

  // ── Response ──
  if (result) {
    console.log(`[price] ✓ Found ${brand}/${ref} via ${source}: ${result.price} EUR`);
    return res.status(200).json({
      success: true,
      brand,
      ref,
      eurPrice: result.price,
      currency: result.currency,
      name: result.name,
      source, // 'direct' or 'browserless'
    });
  } else {
    console.log(`[price] ✗ No price found for ${brand}/${ref}`);
    return res.status(200).json({
      success: false,
      brand,
      ref,
      fallbackUrl: getFallbackUrl(brand, ref),
      message: `Could not auto-fetch price for ${brand} ${ref}. Use the fallback link to check manually.`,
    });
  }
};
