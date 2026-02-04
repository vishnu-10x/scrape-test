import express from 'express';
import { chromium, type Browser, type Page } from 'playwright-core';

// --- Types ---

interface ScrapedAd {
  libraryId: string;
  assetType: 'image' | 'video';
  assetUrl: string | null;
  thumbnailUrl: string | null;
  startDate: string | null;
  endDate: string | null;
  lowImpressionCount: boolean;
  impressions: string | null;
}

interface ScrapeResult {
  success: boolean;
  ads: ScrapedAd[];
  totalFound: number;
  errors: string[];
  durationMs: number;
  advertiserName: string | null;
  diagnostics: Record<string, unknown>[];
  blockedRequests: string[];
  consoleErrors: string[];
}

// --- Constants ---

const MIN_ADS = 10;
const MAX_ADS = 1000;
const DEFAULT_ADS = 400;
const DEFAULT_TIMEOUT_MS = 180_000;
const SCROLL_DELAY_MS = 3_000;
const MAX_STALE_SCROLLS = 10;

// --- Scraper ---

function buildUrl(facebookPageId: string): string {
  const params = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country: 'ALL',
    is_targeted_country: 'false',
    media_type: 'all',
    search_type: 'page',
    'sort_data[mode]': 'total_impressions',
    'sort_data[direction]': 'desc',
    view_all_page_id: facebookPageId,
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

async function dismissCookieConsent(page: Page): Promise<void> {
  try {
    const btn = page.locator(
      'button:has-text("Allow all cookies"), button:has-text("Accept All"), button:has-text("Allow essential and optional cookies")'
    ).first();
    if (await btn.isVisible({ timeout: 3_000 })) {
      await btn.click();
      console.log('[scraper] Dismissed cookie consent');
      await page.waitForTimeout(1_000);
    }
  } catch {
    // No consent dialog
  }
}

async function waitForAdsToRender(page: Page): Promise<void> {
  const selector = 'div.x1plvlek.xryxfnj.x1gzqxud.x178xt8z.x1lun4ml';
  try {
    await page.waitForSelector(selector, { timeout: 15_000 });
    await page.waitForTimeout(2_000);
    console.log('[scraper] Ad containers detected');
  } catch {
    console.warn('[scraper] Ad containers did not appear within 15s');
  }
}

async function collectPageDiagnostics(page: Page, label: string): Promise<Record<string, unknown>> {
  try {
    const diag = await page.evaluate(() => {
      const body = document.body;
      const adContainers = document.querySelectorAll('div.x1plvlek.xryxfnj.x1gzqxud.x178xt8z.x1lun4ml');
      const pageText = body.innerText || '';
      const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const seeMoreButton = allButtons.find(b => /see more|load more|show more/i.test(b.textContent || ''));
      const allDivs = Array.from(document.querySelectorAll('div'));

      return {
        scrollHeight: body.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        scrollY: window.scrollY,
        adContainerCount: adContainers.length,
        hasRateLimit: pageText.includes('rate limit') || pageText.includes('Rate limit'),
        hasCaptcha: !!document.querySelector('iframe[src*="captcha"]') || pageText.includes('CAPTCHA'),
        hasLoginWall: pageText.includes('Log in') && pageText.includes('Create new account'),
        hasErrorMessage: pageText.includes('Something went wrong') || pageText.includes("content isn't available"),
        hasLoadingSpinner: allDivs.some(d => d.getAttribute('role') === 'progressbar' || d.className.includes('loading')),
        hasSeeMoreButton: seeMoreButton ? (seeMoreButton.textContent || '').trim() : null,
        title: document.title,
        url: window.location.href,
      };
    });
    console.log(`[DIAG:${label}]`, JSON.stringify(diag));
    return { label, ...diag };
  } catch (err) {
    console.warn(`[DIAG:${label}] Failed:`, err);
    return { label, error: String(err) };
  }
}

async function extractAdvertiserName(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('div.x8t9es0.x1ldc4aq.x1xlr1w8.x1cgboj8.x4hq6eo.xq9mrsl.x1yc453h.x1h4wwuj.xeuugli');
    return el ? (el.textContent || '').trim() || null : null;
  });
}

async function extractAdsFromDom(page: Page): Promise<ScrapedAd[]> {
  return page.evaluate(() => {
    const adContainers = document.querySelectorAll('div.x1plvlek.xryxfnj.x1gzqxud.x178xt8z.x1lun4ml');
    const ads: Array<{
      libraryId: string;
      assetType: 'image' | 'video';
      assetUrl: string | null;
      thumbnailUrl: string | null;
      startDate: string | null;
      endDate: string | null;
      lowImpressionCount: boolean;
      impressions: string | null;
    }> = [];

    adContainers.forEach((adCard) => {
      const libraryIdSpan = adCard.querySelector('span.x8t9es0.xw23nyj.xo1l8bm.x63nzvj.x108nfp6.xq9mrsl.x1h4wwuj.xeuugli');
      const libraryIdMatch = (libraryIdSpan?.textContent || '').match(/Library ID:[ ]*([0-9]+)/);
      const libraryId = libraryIdMatch ? libraryIdMatch[1] : null;
      if (!libraryId) return;

      const metadataSpans = Array.from(
        adCard.querySelectorAll('span.x8t9es0.xw23nyj.xo1l8bm.x63nzvj.x108nfp6.xq9mrsl.x1h4wwuj.xeuugli')
      );
      let startDate: string | null = null;
      let endDate: string | null = null;

      const dateRangeSpan = metadataSpans.find(s =>
        /[0-9]{1,2} [A-Za-z]{3} [0-9]{4} - [0-9]{1,2} [A-Za-z]{3} [0-9]{4}/.test(s.textContent || '')
      );
      if (dateRangeSpan?.textContent) {
        const parts = dateRangeSpan.textContent.split(' - ');
        if (parts.length === 2) {
          startDate = parts[0].trim();
          endDate = parts[1].trim();
        }
      } else {
        const startSpan = metadataSpans.find(s =>
          /Started running on [0-9]{1,2} [A-Za-z]{3} [0-9]{4}/.test(s.textContent || '')
        );
        if (startSpan?.textContent) {
          const m = startSpan.textContent.match(/Started running on ([0-9]{1,2} [A-Za-z]{3} [0-9]{4})/);
          startDate = m ? m[1] : null;
        }
      }

      const allSpans = Array.from(adCard.querySelectorAll('span'));
      const lowImpressionCount = allSpans.some(s => (s.textContent || '').trim() === 'Low impression count');

      let impressions: string | null = null;
      const impSpan = allSpans.find(s => /Impressions:/.test(s.textContent || ''));
      if (impSpan) {
        const m = (impSpan.textContent || '').match(/Impressions:[ ]*(.+)/);
        impressions = m ? m[1].trim() : null;
      }
      if (!impressions) {
        const countSpan = allSpans.find(s => /^<[0-9]+$/.test((s.textContent || '').trim()));
        impressions = countSpan ? (countSpan.textContent || '').trim() : null;
      }

      const videoEl = adCard.querySelector('video');
      if (videoEl?.src) {
        ads.push({ libraryId, assetType: 'video', assetUrl: videoEl.src, thumbnailUrl: videoEl.poster || null, startDate, endDate, lowImpressionCount, impressions });
        return;
      }

      const images = Array.from(adCard.querySelectorAll('img'));
      const best = images
        .filter(img => img.src && !img.src.includes('data:'))
        .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))[0];
      if (best?.src) {
        ads.push({ libraryId, assetType: 'image', assetUrl: best.src, thumbnailUrl: null, startDate, endDate, lowImpressionCount, impressions });
      }
    });

    return ads;
  });
}

async function scrape(facebookPageId: string, adLimit: number): Promise<ScrapeResult> {
  const startTime = Date.now();
  const limit = Math.max(MIN_ADS, Math.min(MAX_ADS, adLimit));
  const url = buildUrl(facebookPageId);
  const diagnostics: Record<string, unknown>[] = [];
  const blockedRequests: string[] = [];
  const consoleErrors: string[] = [];

  console.log(`[scraper] Starting scrape for ${facebookPageId} (limit: ${limit})`);

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-features=VizDisplayCompositor',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const context = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    page.on('response', response => {
      if (response.status() === 403) {
        blockedRequests.push(`403: ${response.url().substring(0, 200)}`);
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await dismissCookieConsent(page);
    await waitForAdsToRender(page);

    diagnostics.push(await collectPageDiagnostics(page, 'after-initial-load'));

    const advertiserName = await extractAdvertiserName(page);
    if (advertiserName) console.log(`[scraper] Advertiser: "${advertiserName}"`);

    // Scroll loop
    let collectedAds: ScrapedAd[] = [];
    let staleScrollCount = 0;
    let previousAdCount = 0;
    let scrollIteration = 0;

    while (collectedAds.length < limit) {
      if (Date.now() - startTime > DEFAULT_TIMEOUT_MS) {
        console.warn(`[scraper] Timeout reached with ${collectedAds.length} ads`);
        break;
      }

      scrollIteration++;

      const preScrollHeight = await page.evaluate(() => document.body.scrollHeight);
      const preScrollPos = await page.evaluate(() => window.scrollY);

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

      // Click "See more" button if Facebook is gating infinite scroll behind it
      try {
        const seeMoreBtn = page.locator(
          'button:has-text("See more"), [role="button"]:has-text("See more")'
        ).first();
        if (await seeMoreBtn.isVisible({ timeout: 500 })) {
          await seeMoreBtn.click();
          console.log(`[scraper] Clicked "See more" button on scroll #${scrollIteration}`);
          await page.waitForTimeout(1_000);
        }
      } catch {
        // Button not present
      }

      await page.waitForTimeout(SCROLL_DELAY_MS);

      const postScrollHeight = await page.evaluate(() => document.body.scrollHeight);
      const postScrollPos = await page.evaluate(() => window.scrollY);

      collectedAds = await extractAdsFromDom(page);

      console.log(
        `[scraper] Scroll #${scrollIteration}: ${collectedAds.length} ads (prev: ${previousAdCount}, stale: ${staleScrollCount}/${MAX_STALE_SCROLLS}) | ` +
        `scrollHeight: ${preScrollHeight}->${postScrollHeight}, scrollY: ${preScrollPos}->${postScrollPos}`
      );

      if (collectedAds.length === previousAdCount) {
        staleScrollCount++;
        if (staleScrollCount === 1) {
          diagnostics.push(await collectPageDiagnostics(page, 'first-stale-scroll'));
        }
        if (staleScrollCount >= MAX_STALE_SCROLLS) {
          console.log(`[scraper] Stopping after ${MAX_STALE_SCROLLS} stale scrolls at ${collectedAds.length} ads`);
          break;
        }
      } else {
        staleScrollCount = 0;
      }

      previousAdCount = collectedAds.length;
    }

    const ads = collectedAds.slice(0, limit);

    diagnostics.push(await collectPageDiagnostics(page, 'after-scrape-complete'));

    console.log(`[scraper] Complete: ${ads.length} ads collected`);
    if (blockedRequests.length > 0) console.warn(`[scraper] Blocked requests:`, blockedRequests);
    if (consoleErrors.length > 0) console.warn(`[scraper] Console errors:`, consoleErrors);

    return {
      success: true,
      ads,
      totalFound: ads.length,
      errors: [],
      durationMs: Date.now() - startTime,
      advertiserName,
      diagnostics,
      blockedRequests,
      consoleErrors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[scraper] Failed: ${message}`);
    return {
      success: false,
      ads: [],
      totalFound: 0,
      errors: [message],
      durationMs: Date.now() - startTime,
      advertiserName: null,
      diagnostics,
      blockedRequests,
      consoleErrors,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function takeScreenshot(facebookPageId: string): Promise<{ screenshot: string; diagnostics: Record<string, unknown> }> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const context = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const url = buildUrl(facebookPageId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await dismissCookieConsent(page);
    await waitForAdsToRender(page);

    const diag = await collectPageDiagnostics(page, 'screenshot');
    const buffer = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });

    return { screenshot: buffer.toString('base64'), diagnostics: diag };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// --- Express App ---

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/scrape', async (req, res) => {
  const { facebookPageId, adLimit } = req.body;
  if (!facebookPageId || typeof facebookPageId !== 'string') {
    res.status(400).json({ error: 'facebookPageId is required' });
    return;
  }

  try {
    const result = await scrape(facebookPageId, adLimit ?? DEFAULT_ADS);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/screenshot', async (req, res) => {
  const { facebookPageId } = req.body;
  if (!facebookPageId || typeof facebookPageId !== 'string') {
    res.status(400).json({ error: 'facebookPageId is required' });
    return;
  }

  try {
    const { screenshot, diagnostics } = await takeScreenshot(facebookPageId);
    res.json({ screenshot, diagnostics });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
});
