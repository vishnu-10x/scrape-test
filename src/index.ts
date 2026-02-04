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

// --- Enhanced Stealth ---

async function applyStealthScripts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Navigator core properties
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

    // Fake plugins (headless has zero — dead giveaway)
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 },
        ];
        return Object.assign(arr, {
          namedItem: (name: string) => arr.find(p => p.name === name) || null,
          refresh: () => {},
        });
      },
    });

    // Chrome runtime stub (missing in headless = detected)
    const w = window as any;
    w.chrome = {
      runtime: { connect: () => {}, sendMessage: () => {}, id: undefined },
      loadTimes: () => ({}),
      csi: () => ({}),
    };

    // Permissions API override
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params: any) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
        : origQuery(params);

    // WebGL — override SwiftShader (headless giveaway) with real GPU strings
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p: number) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return getParam.call(this, p);
    };
    const getParam2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (p: number) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return getParam2.call(this, p);
    };

    // Network connection info (missing in some headless envs)
    Object.defineProperty(navigator, 'connection', {
      get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }),
    });
  });
}

// --- V2 Scraper ---

interface NetworkEntry {
  url: string;
  status: number;
  method: string;
  type: string;
}

async function scrapeV2(facebookPageId: string, adLimit: number): Promise<ScrapeResult> {
  const startTime = Date.now();
  const limit = Math.max(MIN_ADS, Math.min(MAX_ADS, adLimit));
  const url = buildUrl(facebookPageId);
  const diagnostics: Record<string, unknown>[] = [];
  const blockedRequests: string[] = [];
  const consoleErrors: string[] = [];
  const networkLog: NetworkEntry[] = [];

  console.log(`[v2] Starting scrape for ${facebookPageId} (limit: ${limit})`);

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
        '--window-size=1440,900',
      ],
    });

    const context = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
      },
    });

    const page = await context.newPage();
    await applyStealthScripts(page);

    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    page.on('response', resp => {
      const u = resp.url();
      const status = resp.status();
      if (status === 403) blockedRequests.push(`403: ${u.substring(0, 200)}`);
      // Track Facebook API calls — these are the requests that load more ads
      if (u.includes('/api/graphql') || u.includes('/ajax/') || u.includes('ads_library')) {
        networkLog.push({
          url: u.substring(0, 200),
          status,
          method: resp.request().method(),
          type: resp.request().resourceType(),
        });
      }
    });

    // Phase 1: Full page load — networkidle waits for all JS bundles to download + execute
    console.log('[v2] Navigating (networkidle)...');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    await dismissCookieConsent(page);

    // Phase 2: Wait for ad containers with extended timeout
    const adSelector = 'div.x1plvlek.xryxfnj.x1gzqxud.x178xt8z.x1lun4ml';
    try {
      await page.waitForSelector(adSelector, { timeout: 30_000 });
      console.log('[v2] Ad containers detected');
    } catch {
      console.warn('[v2] Ad containers did not appear within 30s');
    }

    // Phase 3: Extra settle time for Facebook's JS to attach scroll handlers
    await page.waitForTimeout(5_000);

    diagnostics.push(await collectPageDiagnostics(page, 'v2-after-load'));
    diagnostics.push({ label: 'v2-initial-network', requests: [...networkLog] });

    const jsState = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[src]'));
      return {
        scriptCount: scripts.length,
        hasFbJs: scripts.some(s => (s.getAttribute('src') || '').includes('rsrc.php')),
        bodyClasses: document.body.className.substring(0, 200),
      };
    });
    console.log('[v2] JS state:', JSON.stringify(jsState));
    diagnostics.push({ label: 'v2-js-state', ...jsState });

    const advertiserName = await extractAdvertiserName(page);
    if (advertiserName) console.log(`[v2] Advertiser: "${advertiserName}"`);

    // Phase 4: Scroll loop — incremental smooth scrolling instead of jumping to bottom
    let collectedAds: ScrapedAd[] = [];
    let staleScrollCount = 0;
    let previousAdCount = 0;
    let scrollIteration = 0;

    while (collectedAds.length < limit) {
      if (Date.now() - startTime > DEFAULT_TIMEOUT_MS) {
        console.warn(`[v2] Timeout reached with ${collectedAds.length} ads`);
        break;
      }

      scrollIteration++;
      const netCountBefore = networkLog.length;

      // Smooth scroll by ~2 viewport heights (more human-like, triggers IntersectionObserver)
      const vh = await page.evaluate(() => window.innerHeight);
      const prePos = await page.evaluate(() => window.scrollY);
      const preHeight = await page.evaluate(() => document.body.scrollHeight);
      const target = Math.min(prePos + vh * 2, preHeight);

      await page.evaluate((t) => window.scrollTo({ top: t, behavior: 'smooth' }), target);

      // Randomized delay (2.5–5s) to mimic human reading
      const delay = 2500 + Math.floor(Math.random() * 2500);
      await page.waitForTimeout(delay);

      // If near the bottom, wait extra for lazy-loaded content then scroll to absolute end
      const nearBottom = await page.evaluate(() =>
        document.body.scrollHeight - window.scrollY - window.innerHeight < 300
      );
      if (nearBottom) {
        await page.waitForTimeout(2_000);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1_000);
      }

      const postHeight = await page.evaluate(() => document.body.scrollHeight);
      const postPos = await page.evaluate(() => window.scrollY);
      const netCountAfter = networkLog.length;

      collectedAds = await extractAdsFromDom(page);

      console.log(
        `[v2] Scroll #${scrollIteration}: ${collectedAds.length} ads (prev: ${previousAdCount}, stale: ${staleScrollCount}/${MAX_STALE_SCROLLS}) | ` +
        `height: ${preHeight}->${postHeight}, pos: ${prePos}->${postPos}, net: +${netCountAfter - netCountBefore}`
      );

      if (collectedAds.length === previousAdCount) {
        staleScrollCount++;
        if (staleScrollCount === 1) {
          diagnostics.push(await collectPageDiagnostics(page, 'v2-first-stale'));
          diagnostics.push({ label: 'v2-stale-network', recentRequests: networkLog.slice(-5) });
        }
        if (staleScrollCount >= MAX_STALE_SCROLLS) {
          console.log(`[v2] Stopping: ${MAX_STALE_SCROLLS} stale scrolls at ${collectedAds.length} ads`);
          break;
        }
      } else {
        staleScrollCount = 0;
      }

      previousAdCount = collectedAds.length;
    }

    const ads = collectedAds.slice(0, limit);
    diagnostics.push(await collectPageDiagnostics(page, 'v2-complete'));
    diagnostics.push({ label: 'v2-final-network', total: networkLog.length, log: networkLog });

    console.log(`[v2] Done: ${ads.length} ads, ${networkLog.length} API calls tracked`);
    if (blockedRequests.length > 0) console.warn('[v2] Blocked:', blockedRequests);

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
    console.error(`[v2] Failed: ${message}`);
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

// --- V3 Scraper: hydration-aware + GraphQL capture + direct API fallback ---

interface GraphQLCapture {
  reqBody: string;
  respSnippet: string;
  status: number;
}

async function scrapeV3(facebookPageId: string, adLimit: number): Promise<ScrapeResult> {
  const startTime = Date.now();
  const limit = Math.max(MIN_ADS, Math.min(MAX_ADS, adLimit));
  const url = buildUrl(facebookPageId);
  const diagnostics: Record<string, unknown>[] = [];
  const blockedRequests: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const graphqlTraffic: GraphQLCapture[] = [];

  console.log(`[v3] Starting scrape for ${facebookPageId} (limit: ${limit})`);

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
        '--window-size=1440,900',
      ],
    });

    const context = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
      },
    });

    const page = await context.newPage();
    await applyStealthScripts(page);

    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // Capture uncaught JS exceptions (not just console.error)
    page.on('pageerror', err => {
      pageErrors.push(err.message);
    });

    page.on('response', resp => {
      if (resp.status() === 403) blockedRequests.push(`403: ${resp.url().substring(0, 200)}`);
    });

    // Capture GraphQL traffic with request + response bodies
    page.on('response', async (resp) => {
      if (resp.url().includes('/api/graphql')) {
        try {
          const reqBody = resp.request().postData() || '';
          const respBody = await resp.text();
          graphqlTraffic.push({
            reqBody: reqBody.substring(0, 3000),
            respSnippet: respBody.substring(0, 3000),
            status: resp.status(),
          });
          console.log(`[v3] GraphQL captured (${resp.status()}): ${reqBody.substring(0, 80)}...`);
        } catch {}
      }
    });

    // Phase 1: Navigate with networkidle
    console.log('[v3] Navigating (networkidle)...');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    await dismissCookieConsent(page);

    // Phase 2: Wait for FULL React hydration — poll until ads rendered AND spinner gone
    console.log('[v3] Waiting for React hydration...');
    const adSelector = 'div.x1plvlek.xryxfnj.x1gzqxud.x178xt8z.x1lun4ml';
    let hydrated = false;

    for (let i = 0; i < 30; i++) {
      const state = await page.evaluate(() => {
        const ads = document.querySelectorAll('div.x1plvlek.xryxfnj.x1gzqxud.x178xt8z.x1lun4ml');
        const allDivs = Array.from(document.querySelectorAll('div'));
        const hasSpinner = allDivs.some(d =>
          d.getAttribute('role') === 'progressbar' || d.className.includes('loading')
        );
        return { adCount: ads.length, hasSpinner };
      });

      if (i % 5 === 0 || (state.adCount > 0 && !state.hasSpinner)) {
        console.log(`[v3] Hydration check #${i}: ${state.adCount} ads, spinner: ${state.hasSpinner}`);
      }

      if (state.adCount > 0 && !state.hasSpinner) {
        console.log('[v3] Hydration complete');
        hydrated = true;
        break;
      }

      await page.waitForTimeout(2_000);
    }

    if (!hydrated) {
      console.warn('[v3] Hydration did not complete within 60s, continuing anyway');
    }

    // Phase 3: Extra settle time for scroll event handlers to attach
    await page.waitForTimeout(3_000);

    diagnostics.push(await collectPageDiagnostics(page, 'v3-after-hydration'));

    const advertiserName = await extractAdvertiserName(page);
    if (advertiserName) console.log(`[v3] Advertiser: "${advertiserName}"`);

    // Phase 4: Scroll loop with GraphQL monitoring
    let collectedAds = await extractAdsFromDom(page);
    console.log(`[v3] Initial extraction: ${collectedAds.length} ads`);

    let staleScrollCount = 0;
    let previousAdCount = collectedAds.length;
    let scrollIteration = 0;

    while (collectedAds.length < limit) {
      if (Date.now() - startTime > DEFAULT_TIMEOUT_MS) {
        console.warn(`[v3] Timeout at ${collectedAds.length} ads`);
        break;
      }

      scrollIteration++;
      const gqlBefore = graphqlTraffic.length;

      // Scroll to bottom (same as v1 which works locally)
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

      // Click "See more" if visible
      try {
        const btn = page.locator(
          'button:has-text("See more"), [role="button"]:has-text("See more")'
        ).first();
        if (await btn.isVisible({ timeout: 500 })) {
          await btn.click();
          console.log(`[v3] Clicked See more on scroll #${scrollIteration}`);
          await page.waitForTimeout(2_000);
        }
      } catch {}

      await page.waitForTimeout(SCROLL_DELAY_MS);

      const gqlAfter = graphqlTraffic.length;
      collectedAds = await extractAdsFromDom(page);

      console.log(
        `[v3] Scroll #${scrollIteration}: ${collectedAds.length} ads (prev: ${previousAdCount}, stale: ${staleScrollCount}/${MAX_STALE_SCROLLS}) | gql: +${gqlAfter - gqlBefore}`
      );

      if (collectedAds.length === previousAdCount) {
        staleScrollCount++;
        if (staleScrollCount === 1) {
          diagnostics.push(await collectPageDiagnostics(page, 'v3-first-stale'));
        }
        // After 3 stale scrolls, switch to direct API approach
        if (staleScrollCount >= 3 && collectedAds.length <= 30) {
          console.log('[v3] Scroll stuck early. Switching to direct API approach...');
          break;
        }
        if (staleScrollCount >= MAX_STALE_SCROLLS) {
          console.log(`[v3] Stopping: ${MAX_STALE_SCROLLS} stale scrolls at ${collectedAds.length} ads`);
          break;
        }
      } else {
        staleScrollCount = 0;
      }

      previousAdCount = collectedAds.length;
    }

    // Phase 5: If stuck, try direct GraphQL API pagination
    if (collectedAds.length < limit && collectedAds.length <= 30) {
      console.log('[v3] Attempting direct API pagination...');

      // Step A: Extract doc_id and fb_dtsg from CAPTURED GraphQL traffic
      // (they're URL-encoded form params in every request body)
      let trafficDocId: string | null = null;
      let trafficDtsg: string | null = null;
      let trafficLsd: string | null = null;
      let adQueryDocId: string | null = null;

      for (const traffic of graphqlTraffic) {
        try {
          const params = new URLSearchParams(traffic.reqBody);
          const docId = params.get('doc_id');
          const dtsg = params.get('fb_dtsg');
          const lsd = params.get('lsd');
          const vars = params.get('variables');

          if (docId && !trafficDocId) trafficDocId = docId;
          if (dtsg && !trafficDtsg) trafficDtsg = dtsg;
          if (lsd && !trafficLsd) trafficLsd = lsd;

          // Identify the ad search query by checking variables or response
          if (vars && (vars.includes('viewAllPageID') || vars.includes('view_all_page_id'))) {
            adQueryDocId = docId;
            console.log(`[v3] Found ad query doc_id from variables: ${docId}`);
          }
          if (traffic.respSnippet.includes('ad_archive_id') || traffic.respSnippet.includes('library_id') || traffic.respSnippet.includes('forward_cursor')) {
            if (docId) {
              adQueryDocId = docId;
              console.log(`[v3] Found ad query doc_id from response content: ${docId}`);
            }
          }
        } catch {}
      }

      // Step B: Extract pagination cursor from page embedded data
      const pageState = await page.evaluate(() => {
        const allText = Array.from(document.querySelectorAll('script'))
          .map(s => s.textContent || '')
          .join('\n');

        const fwdCursorMatch = allText.match(/"forward_cursor"\s*:\s*"([^"]+)"/);
        const endCursorMatch = allText.match(/"end_cursor"\s*:\s*"([^"]+)"/);
        const hasNextMatch = allText.match(/"has_next_page"\s*:\s*(true|false)/);
        const collationMatch = allText.match(/"collation_token"\s*:\s*"([^"]+)"/);
        const sessionMatch = allText.match(/"session_id"\s*:\s*"([^"]+)"/);

        return {
          forwardCursor: fwdCursorMatch?.[1] || null,
          endCursor: endCursorMatch?.[1] || null,
          hasNextPage: hasNextMatch?.[1] || null,
          collationToken: collationMatch?.[1] || null,
          sessionId: sessionMatch?.[1] || null,
        };
      });

      const cursor = pageState.forwardCursor || pageState.endCursor;
      const finalDocId = adQueryDocId || trafficDocId;
      const finalDtsg = trafficDtsg;

      console.log('[v3] Token sources:', JSON.stringify({
        fromTraffic: { docId: finalDocId, hasDtsg: !!finalDtsg, hasLsd: !!trafficLsd, capturedCalls: graphqlTraffic.length },
        fromPage: { cursor: cursor?.substring(0, 30) || null, hasNextPage: pageState.hasNextPage },
      }));

      diagnostics.push({ label: 'v3-tokens', trafficDocId, adQueryDocId, hasDtsg: !!finalDtsg, hasLsd: !!trafficLsd, ...pageState });
      diagnostics.push({ label: 'v3-graphql-traffic', traffic: graphqlTraffic });

      if (cursor && finalDtsg && finalDocId) {
        console.log(`[v3] All tokens found. Starting direct API pagination (doc_id=${finalDocId})...`);

        let currentCursor: string | null = cursor;
        let apiPage = 0;
        const apiAds: ScrapedAd[] = [];

        while ((collectedAds.length + apiAds.length) < limit && currentCursor && apiPage < 50) {
          if (Date.now() - startTime > DEFAULT_TIMEOUT_MS) break;
          apiPage++;

          console.log(`[v3] API page #${apiPage}, cursor: ${currentCursor.substring(0, 30)}..., total: ${collectedAds.length + apiAds.length}`);

          const apiResult: { ok: boolean; status: number; body: string } = await page.evaluate(
            async ({ docId, cursor, pageId, dtsg, lsd, collationToken, sessionId }) => {
              try {
                const variables = JSON.stringify({
                  activeStatus: 'active',
                  adType: 'ALL',
                  bylines: [],
                  collationToken: collationToken || '',
                  contentLanguages: [],
                  countries: ['ALL'],
                  cursor: cursor,
                  excludedIDs: [],
                  first: 30,
                  mediaType: 'ALL',
                  pageIDs: [],
                  potentialReachInput: [],
                  publisherPlatforms: [],
                  queryString: '',
                  regions: [],
                  searchType: 'page',
                  sessionID: sessionId || '',
                  sortData: { mode: 'TOTAL_IMPRESSIONS', direction: 'DESCENDING' },
                  source: null,
                  startDate: null,
                  v: 'default',
                  viewAllPageID: pageId,
                });

                const params = new URLSearchParams();
                params.append('doc_id', docId);
                params.append('variables', variables);
                params.append('fb_dtsg', dtsg);
                if (lsd) params.append('lsd', lsd);

                const resp = await fetch('/api/graphql/', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: params.toString(),
                  credentials: 'include',
                });

                const text = await resp.text();
                return { ok: true, status: resp.status, body: text };
              } catch (e) {
                return { ok: false, status: 0, body: String(e) };
              }
            },
            {
              docId: finalDocId,
              cursor: currentCursor,
              pageId: facebookPageId,
              dtsg: finalDtsg,
              lsd: trafficLsd,
              collationToken: pageState.collationToken,
              sessionId: pageState.sessionId,
            }
          );

          if (!apiResult.ok || apiResult.status !== 200) {
            console.log(`[v3] API call failed: status=${apiResult.status}`);
            diagnostics.push({ label: `v3-api-fail-${apiPage}`, status: apiResult.status, snippet: apiResult.body.substring(0, 1000) });
            break;
          }

          console.log(`[v3] API page #${apiPage}: ${apiResult.status}, ${apiResult.body.length} chars`);

          try {
            // Facebook prefixes responses with "for (;;);" to prevent JSON hijacking
            const jsonText = apiResult.body.replace(/^for \(;;\);/, '');
            const bodyStr = jsonText;

            // Extract next cursor
            const nextFwdMatch = bodyStr.match(/"forward_cursor"\s*:\s*"([^"]+)"/);
            const nextEndMatch = bodyStr.match(/"end_cursor"\s*:\s*"([^"]+)"/);
            const nextCursor = nextFwdMatch?.[1] || nextEndMatch?.[1] || null;
            const hasAdData = bodyStr.includes('ad_archive_id') || bodyStr.includes('library_id');

            console.log(`[v3] API page #${apiPage}: hasAdData=${hasAdData}, nextCursor=${nextCursor ? 'yes' : 'no'}`);

            if (hasAdData) {
              // Extract ad IDs from the response (library_id / ad_archive_id)
              const idMatches = [...bodyStr.matchAll(/"(?:ad_archive_id|library_id)"\s*:\s*"?(\d+)"?/g)];
              const uniqueIds = [...new Set(idMatches.map(m => m[1]))];

              // Extract ad nodes as best-effort from the JSON
              for (const adId of uniqueIds) {
                // Skip if we already have this ad
                if (collectedAds.some(a => a.libraryId === adId) || apiAds.some(a => a.libraryId === adId)) continue;

                // Extract what we can from the JSON near this ad ID
                const adRegion = bodyStr.substring(
                  Math.max(0, bodyStr.indexOf(adId) - 500),
                  Math.min(bodyStr.length, bodyStr.indexOf(adId) + 2000)
                );

                // Start date
                const startMatch = adRegion.match(/"start_date"\s*:\s*(\d+)/);
                let startDate: string | null = null;
                if (startMatch) {
                  const d = new Date(parseInt(startMatch[1]) * 1000);
                  startDate = `${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })} ${d.getFullYear()}`;
                }

                // Snapshot/image URL
                const snapshotMatch = adRegion.match(/"snapshot_url"\s*:\s*"([^"]+)"/);
                const imageMatch = adRegion.match(/"resized_image_url"\s*:\s*"([^"]+)"/) || adRegion.match(/"original_image_url"\s*:\s*"([^"]+)"/);
                const videoMatch = adRegion.match(/"video_hd_url"\s*:\s*"([^"]+)"/) || adRegion.match(/"video_sd_url"\s*:\s*"([^"]+)"/);

                const hasVideo = !!videoMatch;
                const assetUrl = hasVideo
                  ? videoMatch![1].replace(/\\\//g, '/')
                  : (imageMatch?.[1] || snapshotMatch?.[1] || '').replace(/\\\//g, '/') || null;

                apiAds.push({
                  libraryId: adId,
                  assetType: hasVideo ? 'video' : 'image',
                  assetUrl,
                  thumbnailUrl: null,
                  startDate,
                  endDate: null,
                  lowImpressionCount: false,
                  impressions: null,
                });
              }

              console.log(`[v3] Extracted ${uniqueIds.length} ads from API page #${apiPage} (${apiAds.length} total API ads)`);
            } else {
              console.log(`[v3] API page #${apiPage}: no ad data found`);
              diagnostics.push({ label: `v3-api-no-data-${apiPage}`, snippet: apiResult.body.substring(0, 2000) });
              break;
            }

            if (!nextCursor) {
              console.log('[v3] No next cursor — reached end of results');
              break;
            }
            currentCursor = nextCursor;

            // Small delay between API calls
            await page.waitForTimeout(1000 + Math.floor(Math.random() * 1000));
          } catch (e) {
            console.log(`[v3] Failed to parse API response: ${e}`);
            diagnostics.push({ label: `v3-api-parse-fail-${apiPage}`, snippet: apiResult.body.substring(0, 2000) });
            break;
          }
        }

        if (apiAds.length > 0) {
          console.log(`[v3] API pagination collected ${apiAds.length} additional ads`);
          collectedAds = [...collectedAds, ...apiAds];
        }
      } else {
        console.log('[v3] Missing tokens for API approach:', {
          hasCursor: !!cursor,
          hasDtsg: !!finalDtsg,
          hasDocId: !!finalDocId,
        });
        diagnostics.push({
          label: 'v3-missing-tokens',
          hasCursor: !!cursor,
          hasDtsg: !!finalDtsg,
          hasDocId: !!finalDocId,
        });
      }
    }

    const ads = collectedAds.slice(0, limit);
    diagnostics.push(await collectPageDiagnostics(page, 'v3-complete'));

    if (pageErrors.length > 0) {
      console.warn('[v3] Page errors:', pageErrors);
      diagnostics.push({ label: 'v3-page-errors', errors: pageErrors });
    }

    console.log(`[v3] Done: ${ads.length} ads, ${graphqlTraffic.length} GraphQL calls captured`);
    if (blockedRequests.length > 0) console.warn('[v3] Blocked:', blockedRequests);

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
    console.error(`[v3] Failed: ${message}`);
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

// --- Diagnose ---

async function diagnose(facebookPageId: string): Promise<Record<string, unknown>> {
  let browser: Browser | null = null;
  const networkLog: (NetworkEntry & { size: number })[] = [];
  const consoleMessages: { type: string; text: string }[] = [];

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-blink-features=AutomationControlled',
      ],
    });

    const context = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
      },
    });

    const page = await context.newPage();
    await applyStealthScripts(page);

    // Capture ALL console messages (not just errors)
    page.on('console', msg => {
      consoleMessages.push({ type: msg.type(), text: msg.text().substring(0, 500) });
    });

    // Capture ALL network responses
    page.on('response', resp => {
      networkLog.push({
        url: resp.url().substring(0, 300),
        status: resp.status(),
        method: resp.request().method(),
        type: resp.request().resourceType(),
        size: Number(resp.headers()['content-length'] || 0),
      });
    });

    const url = buildUrl(facebookPageId);
    console.log('[diagnose] Loading page (networkidle)...');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    await dismissCookieConsent(page);
    await page.waitForTimeout(5_000);

    const pageDiag = await collectPageDiagnostics(page, 'diagnose');

    const jsState = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[src]'));
      return {
        totalScripts: scripts.length,
        scriptSrcs: scripts.slice(0, 20).map(s => s.getAttribute('src')?.substring(0, 100) || ''),
        hasFbJs: scripts.some(s => (s.getAttribute('src') || '').includes('rsrc.php')),
        bodyClassCount: document.body.className.split(' ').length,
        htmlLang: document.documentElement.lang,
        metaViewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || null,
      };
    });
    console.log('[diagnose] JS state:', JSON.stringify(jsState));

    // Test one scroll to see if the page responds
    console.log('[diagnose] Testing scroll...');
    const preScrollAds = await page.evaluate(() =>
      document.querySelectorAll('div.x1plvlek.xryxfnj.x1gzqxud.x178xt8z.x1lun4ml').length
    );
    const preScrollHeight = await page.evaluate(() => document.body.scrollHeight);

    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    await page.waitForTimeout(5_000);

    const postScrollAds = await page.evaluate(() =>
      document.querySelectorAll('div.x1plvlek.xryxfnj.x1gzqxud.x178xt8z.x1lun4ml').length
    );
    const postScrollHeight = await page.evaluate(() => document.body.scrollHeight);

    // Verdict: only count as "working" if we got ads BEYOND the initial SSR batch (~21).
    // Going from 0→21 is just the SSR content finishing its render, not infinite scroll.
    const scrollTrulyLoaded = preScrollAds > 0
      ? postScrollAds > preScrollAds       // Had ads before scroll, got more after
      : postScrollAds > 25;                // Had 0 ads, need to exceed SSR batch (~21) to count

    const scrollTest = {
      preScrollAds,
      postScrollAds,
      preScrollHeight,
      postScrollHeight,
      newAdsLoaded: postScrollAds - preScrollAds,
      heightGrew: postScrollHeight > preScrollHeight,
      verdict: scrollTrulyLoaded ? 'INFINITE_SCROLL_WORKING' : 'INFINITE_SCROLL_BROKEN',
    };
    console.log('[diagnose] Scroll test:', JSON.stringify(scrollTest));

    const screenshot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });

    // Categorize network requests
    const byType: Record<string, number> = {};
    const byStatus: Record<number, number> = {};
    for (const entry of networkLog) {
      byType[entry.type] = (byType[entry.type] || 0) + 1;
      byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
    }

    const fbApiCalls = networkLog.filter(e =>
      e.url.includes('/api/graphql') || e.url.includes('/ajax/')
    );

    return {
      pageDiagnostics: pageDiag,
      scrollTest,
      jsState,
      networkSummary: { total: networkLog.length, byType, byStatus },
      fbApiCalls,
      consoleMessages: consoleMessages.slice(-50),
      fullNetworkLog: networkLog,
      screenshot: screenshot.toString('base64'),
    };
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

app.post('/scrape-v2', async (req, res) => {
  const { facebookPageId, adLimit } = req.body;
  if (!facebookPageId || typeof facebookPageId !== 'string') {
    res.status(400).json({ error: 'facebookPageId is required' });
    return;
  }

  try {
    const result = await scrapeV2(facebookPageId, adLimit ?? DEFAULT_ADS);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/scrape-v3', async (req, res) => {
  const { facebookPageId, adLimit } = req.body;
  if (!facebookPageId || typeof facebookPageId !== 'string') {
    res.status(400).json({ error: 'facebookPageId is required' });
    return;
  }

  try {
    const result = await scrapeV3(facebookPageId, adLimit ?? DEFAULT_ADS);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/diagnose', async (req, res) => {
  const { facebookPageId } = req.body;
  if (!facebookPageId || typeof facebookPageId !== 'string') {
    res.status(400).json({ error: 'facebookPageId is required' });
    return;
  }

  try {
    const result = await diagnose(facebookPageId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
});
