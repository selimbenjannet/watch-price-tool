const fetch = require('node-fetch');
const cheerio = require('cheerio');

// ─── Load headless Chrome (optional — for Phase 2 scraping) ───
let chromium, puppeteer;
try {
  chromium = require('@sparticuz/chromium');
  puppeteer = require('puppeteer-core');
} catch (e) {
  console.log('[init] Chromium not available — Phase 2 disabled');
}

// ─── Browser-like headers ───
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
};

const TUDOR_HEADERS = {
  ...HEADERS,
  'Cookie': 'country=FR; selectedCountry=FR; userCountry=FR; region=FR; locale=fr_FR',
};


// ═══════════════════════════════════════════════════════════
// PHASE 1 — Direct HTTP fetch (fast, free, sometimes blocked)
//   Timeout: 2 seconds — just enough to catch easy wins
// ═══════════════════════════════════════════════════════════

async function raceWithTimeout(promises, timeoutMs) {
  return Promise.race([
    Promise.any(promises).catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

async function tryFetchPrice(url, brand, timeoutMs = 1800) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const price = extractPriceFromHTML(html, brand);
    if (price) return { price, currency: 'EUR', name: extractNameFromHTML(html) || null };
    throw new Error('No price found');
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

async function tryFetchPriceTudor(url, timeoutMs = 1800) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: TUDOR_HEADERS, redirect: 'follow', signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const price = extractPriceFromHTML(html, 'tudor');
    if (price) return { price, currency: 'EUR', name: extractNameFromHTML(html) || null };
    throw new Error('No price found');
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// Chopard: SFCC API — confirmed working, no Phase 2 needed
async function getChopardPrice(ref) {
  const url = `https://www.chopard.com/on/demandware.store/Sites-chopard-Site/fr_FR/Product-Variation?pid=${encodeURIComponent(ref)}&format=ajax`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(url, {
      headers: { ...HEADERS, 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.product?.price?.sales?.value) {
      return { price: data.product.price.sales.value, currency: 'EUR', name: data.product.productName || ref };
    }
    if (data?.product?.gtmData?.price) {
      return { price: parseFloat(data.product.gtmData.price), currency: 'EUR', name: data.product.gtmData.name || ref };
    }
    return null;
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

// Longines Phase 1
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
  const attempts = LONGINES_COLLECTIONS.map(col =>
    tryFetchPrice(`https://www.longines.com/fr/p/watch-${col}-${refFormatted}`, 'longines')
  );
  attempts.push(tryFetchPrice(`https://api.ecom.longines.com/fr/search?q=${encodeURIComponent(ref)}`, 'longines'));
  const result = await raceWithTimeout(attempts, 2000);
  return result ? { ...result, name: result.name || ref } : null;
}

// Tudor Phase 1
const TUDOR_FAMILIES = [
  'daring-watches', 'black-bay', 'black-bay-chrono',
  'pelagos', 'pelagos-fxd', 'tudor-royal',
  '1926', 'ranger', 'glamour-date',
];

async function getTudorPrice(ref) {
  const refLower = ref.toLowerCase();
  const attempts = TUDOR_FAMILIES.map(family =>
    tryFetchPriceTudor(`https://www.tudorwatch.com/en/watch-family/${family}/${refLower}`)
  );
  ['black-bay', 'pelagos', 'royal', '1926', 'ranger'].forEach(col =>
    attempts.push(tryFetchPriceTudor(`https://www.tudorwatch.com/en/watches/${col}/${refLower}`))
  );
  const result = await raceWithTimeout(attempts, 2000);
  return result ? { ...result, name: result.name || ref } : null;
}

// Hublot Phase 1
async function getHublotPrice(ref) {
  const refSlug = ref.toLowerCase().replace(/\./g, '-');
  const attempts = [
    tryFetchPrice(`https://www.hublot.com/fr-fr/find-your-hublot?query=${encodeURIComponent(ref)}`, 'hublot'),
    tryFetchPrice(`https://www.hublot.com/fr-fr/watches/${refSlug}`, 'hublot'),
  ];
  const result = await raceWithTimeout(attempts, 2000);
  return result ? { ...result, name: result.name || ref } : null;
}


// ═══════════════════════════════════════════════════════════
// PHASE 2 — Headless Chrome (reliable, renders JavaScript)
//   Uses @sparticuz/chromium built into the Vercel function
//   No external service or API key needed!
// ═══════════════════════════════════════════════════════════

/**
 * Launch headless Chrome, navigate to the URL, wait for price
 * to appear in the DOM, and return the rendered HTML.
 */
async function scrapeWithChromium(url, options = {}) {
  if (!chromium || !puppeteer) return null;

  let browser = null;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 720 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // Look like a real French browser
    await page.setUserAgent(HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7' });

    // Block images, fonts, CSS to speed up loading
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Set cookies before navigation (e.g., Tudor France cookies)
    if (options.cookies && options.cookies.length > 0) {
      await page.setCookie(...options.cookies);
    }

    // Navigate
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 5500,
    });

    // Wait for a price (€ symbol) to appear in the page
    await page.waitForFunction(() => {
      const text = document.body ? document.body.innerText : '';
      return /\d[\d\s.,]+\s*€/.test(text) || /€\s*[\d\s.,]+/.test(text);
    }, { timeout: 3000 }).catch(() => {});

    const html = await page.content();
    await browser.close();
    return html;
  } catch (e) {
    console.log(`[chromium] Error scraping ${url}: ${e.message}`);
    if (browser) try { await browser.close(); } catch {}
    return null;
  }
}

/**
 * Tudor-specific: try multiple family URLs in a single browser session.
 * Much faster than launching a new browser for each URL.
 */
async function scrapeTudorChromium(ref) {
  if (!chromium || !puppeteer) return null;

  const refLower = ref.toLowerCase();
  const families = guessTudorFamilies(ref);

  let browser = null;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 720 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setUserAgent(HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7' });

    // Block heavy resources
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Set France cookies
    await page.setCookie(
      { name: 'country', value: 'FR', domain: '.tudorwatch.com', path: '/' },
      { name: 'selectedCountry', value: 'FR', domain: '.tudorwatch.com', path: '/' },
      { name: 'userCountry', value: 'FR', domain: '.tudorwatch.com', path: '/' },
      { name: 'region', value: 'FR', domain: '.tudorwatch.com', path: '/' },
      { name: 'locale', value: 'fr_FR', domain: '.tudorwatch.com', path: '/' },
    );

    // Try each guessed family URL in the same browser session
    for (const family of families) {
      try {
        const url = `https://www.tudorwatch.com/en/watch-family/${family}/${refLower}`;
        console.log(`[chromium] Tudor trying: ${family}/${refLower}`);

        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 3000 });
        if (!response || response.status() !== 200) continue;

        // Wait for price to appear
        await page.waitForFunction(() => {
          const text = document.body ? document.body.innerText : '';
          return /\d[\d\s.,]+\s*€/.test(text) || /€\s*[\d\s.,]+/.test(text);
        }, { timeout: 2500 }).catch(() => {});

        const html = await page.content();
        const price = extractPriceFromHTML(html, 'tudor');
        if (price) {
          const name = extractNameFromHTML(html) || ref;
          console.log(`[chromium] ✓ Tudor found: ${price} EUR via family ${family}`);
          await browser.close();
          return { price, currency: 'EUR', name };
        }
      } catch (e) {
        // This family didn't work, try next
        continue;
      }
    }

    await browser.close();
    return null;
  } catch (e) {
    console.log(`[chromium] Tudor error: ${e.message}`);
    if (browser) try { await browser.close(); } catch {}
    return null;
  }
}

/**
 * Guess which Tudor families a reference number belongs to.
 * Returns 2-3 most likely families to keep within the time budget.
 */
function guessTudorFamilies(ref) {
  const clean = ref.toUpperCase().replace(/^M/, '');
  if (/^79[0-3]/.test(clean)) return ['black-bay', 'black-bay-chrono', 'ranger'];
  if (/^79[4-9]/.test(clean)) return ['black-bay', 'daring-watches'];
  if (/^25/.test(clean))       return ['pelagos', 'pelagos-fxd'];
  if (/^28/.test(clean))       return ['tudor-royal'];
  if (/^91/.test(clean))       return ['1926', 'glamour-date'];
  return ['black-bay', 'pelagos', 'tudor-royal'];
}

/**
 * Phase 2 dispatcher — picks the right scraping strategy per brand.
 */
async function getChromiumPrice(brand, ref) {
  console.log(`[chromium] Phase 2 — ${brand} / ${ref}`);

  switch (brand) {
    case 'longines': {
      // Longines: try the search page (JS-rendered)
      const html = await scrapeWithChromium(
        `https://www.longines.com/fr/search?q=${encodeURIComponent(ref)}`
      );
      if (html) {
        const price = extractPriceFromHTML(html, 'longines');
        if (price) return { price, currency: 'EUR', name: extractNameFromHTML(html) || ref };
      }
      return null;
    }

    case 'tudor': {
      // Tudor: specialized multi-family scraping in one browser
      return scrapeTudorChromium(ref);
    }

    case 'hublot': {
      // Hublot: try search page
      const html = await scrapeWithChromium(
        `https://www.hublot.com/fr-fr/find-your-hublot?query=${encodeURIComponent(ref)}`
      );
      if (html) {
        const price = extractPriceFromHTML(html, 'hublot');
        if (price) return { price, currency: 'EUR', name: extractNameFromHTML(html) || ref };
      }
      return null;
    }

    default:
      return null;
  }
}


// ═══════════════════════════════════════════════════════════
// Price & name extraction from HTML
// ═══════════════════════════════════════════════════════════

function extractPriceFromHTML(html, brand) {
  const $ = cheerio.load(html);

  // Strategy 1: JSON-LD structured data
  let jsonLdPrice = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (jsonLdPrice) return false;
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

  // Strategy 2: dataLayer / GTM
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

  // Strategy 4: CSS selectors
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

  // Strategy 5: €/EUR then amount
  const eurMatch = html.match(/(?:€|EUR)\s*([\d\s.,]+)/);
  if (eurMatch) {
    const price = parseFloat(eurMatch[1].replace(/[\s,]/g, '').replace(',', '.'));
    if (price > 0 && price < 1000000) return price;
  }

  // Strategy 6: amount then €/EUR
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
    case 'chopard':  return `https://www.chopard.com/fr-fr/search?q=${encoded}`;
    case 'longines': return `https://www.google.com/search?q=site:longines.com/fr+"${encoded}"`;
    case 'tudor':    return `https://www.google.com/search?q=site:tudorwatch.com+"${encoded}"`;
    case 'hublot':   return `https://www.google.com/search?q=Hublot+"${encoded}"+prix+EUR+france`;
    default:         return `https://www.google.com/search?q="${encoded}"+prix+EUR+france`;
  }
}


// ═══════════════════════════════════════════════════════════
// Main API handler
// ═══════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ref, brand: brandParam } = req.query;
  if (!ref) return res.status(400).json({ error: 'Missing reference number (ref)' });

  const brand = brandParam || detectBrand(ref);
  if (!brand) {
    return res.status(400).json({ error: 'Could not detect brand. Please specify brand parameter.', detectedBrand: null });
  }

  console.log(`[price] ── Looking up ${brand} / ${ref} ──`);

  let result = null;
  let source = null;

  // ── CHOPARD: API only (already works perfectly) ──
  if (brand === 'chopard') {
    try {
      result = await getChopardPrice(ref);
      if (result) source = 'api';
    } catch (e) {
      console.error('[price] Chopard error:', e.message);
    }
  } else {
    // ── PHASE 1: Quick direct HTTP fetch (2 seconds) ──
    try {
      switch (brand) {
        case 'longines': result = await getLonginesPrice(ref); break;
        case 'tudor':    result = await getTudorPrice(ref);    break;
        case 'hublot':   result = await getHublotPrice(ref);   break;
      }
      if (result) source = 'direct';
    } catch (e) {
      console.error('[price] Phase 1 error:', e.message);
    }

    // ── PHASE 2: Headless Chrome (if Phase 1 failed) ──
    if (!result) {
      try {
        result = await getChromiumPrice(brand, ref);
        if (result) source = 'chromium';
      } catch (e) {
        console.error('[price] Phase 2 error:', e.message);
      }
    }
  }

  // ── RESPONSE ──
  if (result) {
    console.log(`[price] ✓ ${brand}/${ref} → ${result.price} EUR (via ${source})`);
    return res.status(200).json({
      success: true,
      brand,
      ref,
      eurPrice: result.price,
      currency: result.currency,
      name: result.name,
      source,
    });
  } else {
    console.log(`[price] ✗ ${brand}/${ref} → fallback`);
    return res.status(200).json({
      success: false,
      brand,
      ref,
      fallbackUrl: getFallbackUrl(brand, ref),
      message: `Could not auto-fetch price for ${brand} ${ref}. Use the fallback link to check manually.`,
    });
  }
};
