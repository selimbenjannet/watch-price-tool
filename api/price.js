const fetch = require('node-fetch');
const cheerio = require('cheerio');

// ─── Browser-like headers to avoid 403 blocks ───
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
};

// ─── Chopard: SFCC API (confirmed working) ───
async function getChopardPrice(ref) {
  const url = `https://www.chopard.com/on/demandware.store/Sites-chopard-Site/fr_FR/Product-Variation?pid=${encodeURIComponent(ref)}&format=ajax`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
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

  // Extract price from the JSON response
  if (data?.product?.price?.sales?.value) {
    return {
      price: data.product.price.sales.value,
      currency: 'EUR',
      name: data.product.productName || ref,
    };
  }

  // Try gtmData fallback
  if (data?.product?.gtmData?.price) {
    return {
      price: parseFloat(data.product.gtmData.price),
      currency: 'EUR',
      name: data.product.gtmData.name || ref,
    };
  }

  return null;
}

// ─── Helper: race all fetches with a global timeout ───
async function raceWithTimeout(promises, timeoutMs) {
  return Promise.race([
    Promise.any(promises).catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

// ─── Helper: try to fetch a URL and extract price ───
async function tryFetchPrice(url, brand) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
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

// ─── Longines: try ALL collection URLs in parallel ───
const LONGINES_COLLECTIONS = [
  'hydroconquest', 'master-collection', 'spirit', 'conquest',
  'elegant-collection', 'dolcevita', 'heritage-classic',
  'la-grande-classique-de-longines', 'record', 'flagship',
  'primaluna', 'symphonette', 'mini-dolcevita',
  'longines-spirit', 'heritage-military', 'legend-diver',
  'ultra-chron', 'pilot', 'skin-diver',
];

async function getLonginesPrice(ref) {
  // Convert ref like "L3.742.4.96.6" to URL format "l3-742-4-96-6"
  const refFormatted = ref.toLowerCase().replace(/\./g, '-');

  // Fire ALL collection URLs in parallel — first success wins
  const attempts = LONGINES_COLLECTIONS.map(collection => {
    const url = `https://www.longines.com/fr/p/watch-${collection}-${refFormatted}`;
    return tryFetchPrice(url, 'longines');
  });

  // Also try the ecommerce API search in parallel
  attempts.push(
    tryFetchPrice(`https://api.ecom.longines.com/fr/search?q=${encodeURIComponent(ref)}`, 'longines')
  );

  // Race: return first successful result, or null after 7s
  const result = await raceWithTimeout(attempts, 7000);
  if (result) {
    return { ...result, name: result.name || ref };
  }
  return null;
}

// ─── Tudor: try product page ───
const TUDOR_COLLECTIONS = [
  'black-bay', 'pelagos', 'royal', '1926', 'glamour',
  'ranger', 'black-bay-chrono', 'black-bay-gmt',
  'black-bay-58', 'black-bay-pro', 'black-bay-54',
  'clair-de-rose', 'style',
];

async function getTudorPrice(ref) {
  // Tudor refs like "M79230N-0001" → "m79230n-0001"
  const refFormatted = ref.toLowerCase();

  // Fire ALL collection URLs in parallel — first success wins
  const attempts = TUDOR_COLLECTIONS.map(collection => {
    const url = `https://www.tudorwatch.com/fr/watches/${collection}/${refFormatted}`;
    return tryFetchPrice(url, 'tudor');
  });

  // Race: return first successful result, or null after 7s
  const result = await raceWithTimeout(attempts, 7000);
  if (result) {
    return { ...result, name: result.name || ref };
  }
  return null;
}

// ─── Hublot: search-based approach ───
async function getHublotPrice(ref) {
  const refSlug = ref.toLowerCase().replace(/\./g, '-');

  // Try both search and direct URL in parallel
  const attempts = [
    tryFetchPrice(`https://www.hublot.com/fr-fr/find-your-hublot?query=${encodeURIComponent(ref)}`, 'hublot'),
    tryFetchPrice(`https://www.hublot.com/fr-fr/watches/${refSlug}`, 'hublot'),
  ];

  const result = await raceWithTimeout(attempts, 7000);
  if (result) {
    return { ...result, name: result.name || ref };
  }
  return null;
}

// ─── Generic price extraction from HTML ───
function extractPriceFromHTML(html, brand) {
  const $ = cheerio.load(html);

  // Strategy 1: JSON-LD structured data
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const offers = data.offers || data.Offers || (data['@graph'] && data['@graph'].find(n => n.offers))?.offers;
      if (offers) {
        const price = offers.price || (offers[0] && offers[0].price);
        if (price) return parseFloat(price);
      }
    } catch (e) {}
  });

  // Strategy 2: dataLayer / GTM ecommerce data
  const scriptContent = html;
  const dataLayerMatch = scriptContent.match(/["']price["']\s*:\s*["']?([\d.,]+)["']?/);
  if (dataLayerMatch) {
    const price = parseFloat(dataLayerMatch[1].replace(',', ''));
    if (price > 0 && price < 1000000) return price;
  }

  // Strategy 3: meta tags
  const metaPrice = $('meta[property="product:price:amount"]').attr('content') ||
                    $('meta[property="og:price:amount"]').attr('content');
  if (metaPrice) return parseFloat(metaPrice);

  // Strategy 4: Common price CSS patterns
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

  // Strategy 5: Regex for EUR price patterns in HTML
  const eurMatch = html.match(/(?:€|EUR)\s*([\d\s.,]+)/);
  if (eurMatch) {
    const price = parseFloat(eurMatch[1].replace(/[\s,]/g, '').replace(',', '.'));
    if (price > 0 && price < 1000000) return price;
  }

  // Strategy 6: Reverse pattern (price then EUR/€)
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

// ─── Auto-detect brand from reference format ───
function detectBrand(ref) {
  ref = ref.trim().toUpperCase();
  // Longines: starts with L followed by digit (e.g., L3.742.4.96.6)
  if (/^L\d/.test(ref)) return 'longines';
  // Tudor: starts with M followed by digits, or 5-digit number (e.g., M79230N-0001, 79230)
  if (/^M\d{3,}/.test(ref)) return 'tudor';
  if (/^\d{5}/.test(ref) && !ref.includes('.')) return 'tudor';
  // Hublot: pattern like 441.NX.1171.RX (digits.letters.digits.letters)
  if (/^\d{3}\.\w{2}\.\d{3,4}\.\w{2}/.test(ref)) return 'hublot';
  // Chopard: 6+ digits optionally with hyphen (e.g., 278602-3003)
  if (/^\d{5,}/.test(ref)) return 'chopard';
  return null;
}

// ─── Fallback URLs for manual lookup ───
function getFallbackUrl(brand, ref) {
  const encoded = encodeURIComponent(ref);
  switch (brand) {
    case 'chopard':
      return `https://www.chopard.com/fr-fr/search?q=${encoded}`;
    case 'longines':
      return `https://www.google.com/search?q=site:longines.com/fr+"${encoded}"+prix`;
    case 'tudor':
      return `https://www.google.com/search?q=site:tudorwatch.com+"${encoded}"+prix+EUR`;
    case 'hublot':
      return `https://www.google.com/search?q=site:hublot.com/fr-fr+"${encoded}"+prix`;
    default:
      return `https://www.google.com/search?q="${encoded}"+prix+EUR+france`;
  }
}

// ─── Main API handler ───
module.exports = async (req, res) => {
  // CORS headers
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

  try {
    switch (brand) {
      case 'chopard':
        result = await getChopardPrice(ref);
        break;
      case 'longines':
        result = await getLonginesPrice(ref);
        break;
      case 'tudor':
        result = await getTudorPrice(ref);
        break;
      case 'hublot':
        result = await getHublotPrice(ref);
        break;
      default:
        return res.status(400).json({ error: `Unknown brand: ${brand}` });
    }
  } catch (e) {
    console.error(`[price] Error for ${brand}/${ref}:`, e.message);
  }

  if (result) {
    return res.status(200).json({
      success: true,
      brand,
      ref,
      eurPrice: result.price,
      currency: result.currency,
      name: result.name,
    });
  } else {
    return res.status(200).json({
      success: false,
      brand,
      ref,
      fallbackUrl: getFallbackUrl(brand, ref),
      message: `Could not auto-fetch price for ${brand} ${ref}. Use the fallback link to check manually.`,
    });
  }
};
