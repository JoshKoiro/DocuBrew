// PDF export: headless Chrome loads the same page as the preview (in print mode) and prints it.
import fs from 'node:fs/promises';
import path from 'node:path';

let puppeteerPromise;
function loadPuppeteer() {
  puppeteerPromise ??= import('puppeteer').then((m) => m.default);
  return puppeteerPromise;
}

/**
 * @param {string} url      print-mode preview URL
 * @param {string} outFile  destination .pdf
 */
export async function exportPdf(url, outFile, { timeout = 120_000 } = {}) {
  const started = Date.now();
  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({
    headless: true,
    args: process.platform === 'linux' ? ['--no-sandbox', '--font-render-hinting=none'] : ['--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url, { waitUntil: 'load', timeout });
    await page.waitForFunction('window.__docubrew && (window.__docubrew.done || window.__docubrew.error)', { timeout });
    const state = await page.evaluate(() => window.__docubrew);
    if (state.error) throw new Error(state.error);
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await page.pdf({ path: outFile, preferCSSPageSize: true, printBackground: true, timeout });
    return { file: outFile, pages: state.pages, ms: Date.now() - started, warnings: errors };
  } finally {
    await browser.close();
  }
}
