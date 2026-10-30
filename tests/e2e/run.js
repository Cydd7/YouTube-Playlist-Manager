/*
 * End-to-end test: loads the real extension into Chromium and drives the
 * dashboard on a stand-in YouTube page (every youtube.com request is answered
 * with mock-youtube.html, served with Trusted Types enforced like YouTube).
 * Google sign-in and the YouTube API are stubbed inside the service worker.
 *
 *   npm run test:e2e              (needs: npm i -D playwright && npx playwright install chromium)
 *   SCREENSHOTS=dir npm run test:e2e   also saves screenshots of the dashboard
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require('../../extension/lib/model.js');

const EXTENSION = path.resolve(__dirname, '../../extension');
const SAMPLE = path.resolve(__dirname, '../../samples/sample-backup.json');
const MOCK_PAGE = fs.readFileSync(path.join(__dirname, 'mock-youtube.html'), 'utf8');
const EXTENSION_ID = 'hbmgcfjjjjkdmbajfejeeabakcakcoil';
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const HOST = '#playlist-manager';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-e2e-'));
const screenshotDir = process.env.SCREENSHOTS;

let context;
let page;
let worker;
let acceptDialogs = true;
const dialogs = [];

// --- helpers -------------------------------------------------------------------

const exact = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const button = (label) => page.locator(`${HOST} .pm-actions .pm-btn`, { hasText: label });
const row = (name, p = page) => p.locator(`${HOST} .pm-row`).filter({ has: p.locator('.pm-name, .pm-link', { hasText: exact(name) }) });
const storage = () => worker.evaluate(() => chrome.storage.local.get(null));

/**
 * The visible tree as text: "F-" open folder, "F+" closed folder, "P-"/"P+"
 * playlists, "V" video, "E" empty placeholder; two spaces per level.
 */
function tree(p = page) {
  return p.evaluate(() => {
    const root = document.querySelector('#playlist-manager')?.shadowRoot;
    if (!root) return null;
    return [...root.querySelectorAll('.pm-row')].map((r) => {
      const depth = Number(r.style.getPropertyValue('--depth'));
      const { kind, open } = r.dataset;
      const name = r.querySelector('.pm-name, .pm-link')?.textContent ?? r.querySelector('.pm-rename')?.value ?? '';
      const mark = kind === 'video' ? 'V' : kind === 'empty' ? 'E' : `${kind[0].toUpperCase()}${open === 'true' ? '-' : '+'}`;
      return `${'  '.repeat(depth)}${mark}${name ? ` ${name}` : ''}`;
    });
  });
}

async function waitFor(check, description, timeout = 5000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${description} (last value: ${JSON.stringify(last)})`);
}

async function expectStatus(pattern) {
  const status = page.locator(`${HOST} .pm-status-text`);
  await waitFor(async () => pattern.test((await status.count()) ? await status.innerText() : ''), `status ${pattern}`);
}

async function expectTree(expected, p = page) {
  await waitFor(async () => JSON.stringify(await tree(p)) === JSON.stringify(expected), `tree ${JSON.stringify(expected)}`)
    .catch(async (err) => {
      throw new Error(`${err.message}\nactual: ${JSON.stringify(await tree(p), null, 1)}`);
    });
}

async function chooseFile(file) {
  const chooser = page.waitForEvent('filechooser');
  await button('Import').click();
  await (await chooser).setFiles(file);
}

async function shot(name) {
  if (!screenshotDir) return;
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.locator(HOST).screenshot({ path: path.join(screenshotDir, `${name}.png`) });
}

const steps = [];
const step = (name, fn) => steps.push({ name, fn });

// --- steps -------------------------------------------------------------------------

step('the extension loads with its pinned ID', async () => {
  assert.equal(new URL(worker.url()).host, EXTENSION_ID);
});

step('shows nothing on other YouTube pages', async () => {
  await page.goto('https://www.youtube.com/');
  await page.waitForTimeout(1200);
  assert.equal(await page.locator(HOST).count(), 0);
});

step('appears above the playlist grid after in-app navigation to Playlists', async () => {
  await page.click('nav a[href="/feed/playlists"]');
  await page.locator(`${HOST} .pm-empty`).waitFor();
  const placement = await page.evaluate(() => {
    const host = document.querySelector('#playlist-manager');
    return [host.parentElement.id, host.closest('ytd-browse').id, host.nextElementSibling.tagName];
  });
  assert.deepEqual(placement, ['primary', 'playlists', 'YTD-RICH-GRID-RENDERER']);
});

step('imports a backup into the empty library', async () => {
  await chooseFile(SAMPLE);
  await expectStatus(/Imported 3 folders, 5 playlists and 12 videos/);
  await expectTree(['F- Music', '  P+ Morning run', '  F+ Focus', 'F+ Learning', 'P+ Cooking ideas', 'P+ Watch someday']);
  const stored = await waitFor(async () => {
    const s = await storage();
    return s['pm.structure']?.root?.length === 4 && s;
  }, 'imported data in storage');
  assert.equal(Object.keys(stored['pm.videos']).length, 11);
  assert.equal(stored['pm.structure'].videos, undefined, 'videos are stored under their own key');
  await shot('1-imported');
});

step('adds a folder and names it without triggering YouTube shortcuts', async () => {
  await button('Folder').click();
  const input = page.locator(`${HOST} .pm-rename`);
  await input.waitFor();
  assert.equal(await input.evaluate((el) => el.getRootNode().activeElement === el), true, 'the name box is focused');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Road/trips');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.shortcutFired), false, 'YouTube\'s "/" shortcut did not fire');
  await expectTree(['F- Music', '  P+ Morning run', '  F+ Focus', 'F+ Learning', 'P+ Cooking ideas', 'P+ Watch someday', 'F- Road/trips', '  E']);
});

step('renames a folder with the pencil button, and Escape cancels', async () => {
  await row('Learning').hover();
  await row('Learning').locator('[data-action="rename"]').click();
  const input = page.locator(`${HOST} .pm-rename`);
  await input.fill('Study');
  await input.press('Enter');
  await waitFor(async () => (await tree()).includes('F+ Study'), 'renamed folder');

  await row('Study').hover();
  await row('Study').locator('[data-action="rename"]').click();
  await input.fill('Nope');
  await input.press('Escape');
  await waitFor(async () => (await tree()).includes('F+ Study'), 'unchanged name');
});

step('renames a folder by double-clicking its name, without toggling it', async () => {
  await row('Study').locator('.pm-name').dblclick();
  const input = page.locator(`${HOST} .pm-rename`);
  await input.fill('Learning');
  await input.press('Enter');
  await waitFor(async () => (await tree()).includes('F+ Learning'), 'renamed, still closed');
});

step('opens and closes folders and playlists', async () => {
  await row('Learning').locator('.pm-name').click();
  await waitFor(async () => (await tree()).includes('  P+ JavaScript talks'), 'folder opened');
  await row('JavaScript talks').locator('.pm-name').click();
  await waitFor(async () => (await tree()).includes('    V Sample: Async JavaScript explained'), 'playlist opened');
  await row('Learning').locator('.pm-twisty').click();
  await waitFor(async () => !(await tree()).includes('  P- JavaScript talks'), 'folder closed');
});

step('drags a playlist into a folder', async () => {
  await row('Cooking ideas').dragTo(row('Road/trips'));
  await expectTree(['F- Music', '  P+ Morning run', '  F+ Focus', 'F+ Learning', 'P+ Watch someday', 'F- Road/trips', '  P+ Cooking ideas']);
});

step('reorders by dropping above a row', async () => {
  await row('Watch someday').dragTo(row('Music'), { targetPosition: { x: 60, y: 3 } });
  await expectTree(['P+ Watch someday', 'F- Music', '  P+ Morning run', '  F+ Focus', 'F+ Learning', 'F- Road/trips', '  P+ Cooking ideas']);
});

step('refuses to put a folder inside its own subfolder', async () => {
  const before = await tree();
  await row('Music').dragTo(row('Focus'));
  await page.waitForTimeout(300);
  assert.deepEqual(await tree(), before);
});

step('moves a video to another playlist and reorders videos', async () => {
  await row('Morning run').locator('.pm-name').click();
  await row('Cooking ideas').locator('.pm-name').click();
  await row('Sample: Weeknight pasta').dragTo(row('Sample: Tempo run playlist'), { targetPosition: { x: 200, y: 4 } });
  await row('Sample: Cool-down stretches').dragTo(row('Sample: Easy 5 km warm-up mix'), { targetPosition: { x: 200, y: 4 } });
  await expectTree([
    'P+ Watch someday',
    'F- Music',
    '  P- Morning run',
    '    V Sample: Cool-down stretches',
    '    V Sample: Easy 5 km warm-up mix',
    '    V Sample: Weeknight pasta',
    '    V Sample: Tempo run playlist',
    '  F+ Focus',
    'F+ Learning',
    'F- Road/trips',
    '  P- Cooking ideas',
    '    V Sample: Bread from scratch',
    '    V Deleted video',
  ]);
});

step('drops a video onto a closed playlist', async () => {
  await row('Sample: Bread from scratch').dragTo(row('Watch someday'));
  await waitFor(async () => {
    const t = await tree();
    return t[0] === 'P- Watch someday' && t[1] === '  V Sample: Bread from scratch';
  }, 'video appended to Watch someday, which opens');
  await row('Watch someday').locator('.pm-twisty').click();
});

step('opens a closed folder while you hover over it during a drag', async () => {
  const focus = row('Focus');
  await row('Watch someday').hover();
  await page.mouse.down();
  const box = await focus.boundingBox();
  await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 6 });
  // Real browsers repeat dragover while the pointer rests; Playwright only sends one per move, so nudge it.
  await page.mouse.move(box.x + 82, box.y + box.height / 2, { steps: 2 });
  await waitFor(async () => (await tree()).includes('    P+ Deep work'), 'Focus opened during the drag', 3000);
  await page.mouse.move(box.x + 84, box.y + box.height / 2, { steps: 2 });
  await page.mouse.up();
  await waitFor(async () => {
    const t = await tree();
    return t.includes('  F- Focus') && t.indexOf('    P+ Deep work') + 1 === t.indexOf('    P+ Watch someday');
  }, 'Watch someday dropped into Focus');
});

step('deletes a folder and keeps what was inside', async () => {
  await row('Road/trips').hover();
  await row('Road/trips').locator('[data-action="delete"]').click();
  await waitFor(async () => !(await tree()).some((r) => r.includes('Road/trips')), 'folder deleted');
  assert.match(dialogs.at(-1), /The 1 item inside will move to the top level/);
  assert.deepEqual((await tree()).slice(-3), ['F+ Learning', 'P- Cooking ideas', '  V Deleted video']);
  await shot('2-organized');
});

step('exports one JSON file with the structure and full video data', async () => {
  await page.waitForTimeout(500); // let the debounced save finish
  const downloadPromise = page.waitForEvent('download');
  await button('Export').click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^playlist-manager-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  assert.deepEqual(M.validate(backup), []);
  const stored = await storage();
  assert.deepEqual(backup.root, stored['pm.structure'].root);
  assert.deepEqual(backup.folders, stored['pm.structure'].folders);
  assert.equal(backup.videos.sampleVid01.statistics.viewCount, '1000');
  assert.equal(backup.videos.sampleGone1.unavailable, true);
  await expectStatus(/Exported 3 folders, 5 playlists and 12 videos/);
});

step('keeps everything after a page reload', async () => {
  const before = await tree();
  await page.reload();
  await page.locator(`${HOST} .pm-row`).first().waitFor();
  await expectTree(before);
});

step("follows YouTube's dark theme", async () => {
  const theme = () => page.evaluate(() => document.querySelector('#playlist-manager').shadowRoot.querySelector('.pm').dataset.theme);
  assert.equal(await theme(), 'light');
  await page.evaluate(() => document.documentElement.setAttribute('dark', ''));
  await waitFor(async () => (await theme()) === 'dark', 'dark theme');
  await shot('3-dark');
  await page.evaluate(() => document.documentElement.removeAttribute('dark'));
  await waitFor(async () => (await theme()) === 'light', 'light theme');
});

step('leaves with in-app navigation and comes back', async () => {
  await page.click('nav a[href="/"]');
  await waitFor(async () => (await page.locator(HOST).count()) === 0, 'dashboard removed');
  await page.click('nav a[href="/feed/playlists"]');
  await page.locator(`${HOST} .pm-row`).first().waitFor();
});

step('puts itself back if YouTube re-renders the page', async () => {
  await page.evaluate(() => document.querySelector('#playlist-manager').remove());
  await page.locator(HOST).waitFor({ timeout: 3000 });
  await page.locator(`${HOST} .pm-row`).first().waitFor();
});

step('collapses, and remembers that across reloads', async () => {
  await page.locator(`${HOST} .pm-collapse`).click();
  await waitFor(async () => (await storage())['pm.ui']?.collapsed === true, 'collapsed state saved');
  await page.reload();
  await page.locator(`${HOST} .pm-collapse[aria-expanded="false"]`).waitFor();
  assert.equal(await page.locator(`${HOST} .pm-tree`).isVisible(), false);
  await page.locator(`${HOST} .pm-collapse`).click();
  await page.locator(`${HOST} .pm-tree`).waitFor();
});

step('shows changes made in another tab', async () => {
  const other = await context.newPage();
  await other.goto('https://www.youtube.com/feed/playlists');
  await other.locator(`${HOST} .pm-row`).first().waitFor();
  await button('Folder').click();
  await page.keyboard.type('Shared');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await tree(other))?.includes('F- Shared'), 'new folder in the other tab');
  await other.close();
});

step('rejects a damaged backup and says why', async () => {
  const before = await tree();
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ format: 'playlist-manager', version: 1, root: ['ghost'], folders: {}, playlists: {}, videos: {} }));
  await chooseFile(bad);
  await expectStatus(/Couldn't import “bad\.json”: The top level lists "ghost", which is not a folder or playlist/);
  assert.deepEqual(await tree(), before);
});

step('asks before replacing the library on import, and can be declined', async () => {
  const before = await tree();
  acceptDialogs = false;
  await chooseFile(SAMPLE);
  await page.waitForTimeout(300);
  acceptDialogs = true;
  assert.match(dialogs.at(-1), /^Replace your current library/);
  assert.deepEqual(await tree(), before);
});

step('explains how to set up Pull when no client ID is configured', async () => {
  await button('Pull from YouTube').click();
  await expectStatus(new RegExp(`isn't set up yet.*https://${EXTENSION_ID}\\.chromiumapp\\.org/`));
  assert.equal(await button('Pull from YouTube').isEnabled(), true);
});

step('pulls every playlist and video from YouTube (Google stubbed)', async () => {
  await worker.evaluate(() => {
    self.PM_CONFIG.googleClientId = 'test-client.apps.googleusercontent.com';
    chrome.identity.launchWebAuthFlow = async ({ url }) => {
      self.lastAuthUrl = url;
      const params = new URL(url).searchParams;
      return `${params.get('redirect_uri')}#access_token=fake-token&token_type=Bearer&expires_in=3599&state=${params.get('state')}`;
    };
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const item = (videoId, title = `Pulled ${videoId}`) => ({
      snippet: { title, publishedAt: '2025-01-01T00:00:00Z', resourceId: { videoId } },
      contentDetails: { videoId },
    });
    self.fetch = async (href, init) => {
      const url = new URL(href);
      if (init.headers.Authorization !== 'Bearer fake-token') return reply({ error: { code: 401, message: 'bad token' } }, 401);
      const endpoint = url.pathname.split('/').pop();
      if (endpoint === 'playlists') {
        return url.searchParams.get('pageToken')
          ? reply({ items: [{ id: 'PLpulled2', snippet: { title: 'Pulled two' }, status: { privacyStatus: 'private' } }] })
          : reply({ items: [{ id: 'PLpulled1', snippet: { title: 'Pulled one' }, status: { privacyStatus: 'public' } }], nextPageToken: 'page2' });
      }
      if (endpoint === 'playlistItems') {
        return url.searchParams.get('playlistId') === 'PLpulled1'
          ? reply({ items: [item('vidA'), item('vidB')] })
          : reply({ items: [item('vidB'), item('vidGone', 'Deleted video')] });
      }
      if (endpoint === 'videos') {
        const ids = url.searchParams.get('id').split(',').filter((id) => id !== 'vidGone');
        return reply({ items: ids.map((id) => ({ id, snippet: { title: `Pulled ${id}`, channelTitle: 'Chan' }, contentDetails: { duration: 'PT4M20S' } })) });
      }
      return reply({ error: { code: 404, message: 'unknown endpoint' } }, 404);
    };
  });

  await button('Pull from YouTube').click();
  await expectStatus(/Pulled 2 playlists with 4 videos\. 1 video is deleted or private\./);
  assert.match(dialogs.at(-1), /^Replace your current folders and playlists/);
  await expectTree(['P+ Pulled one', 'P+ Pulled two']);

  const auth = new URL(await worker.evaluate(() => self.lastAuthUrl)).searchParams;
  assert.equal(auth.get('client_id'), 'test-client.apps.googleusercontent.com');
  assert.equal(auth.get('scope'), 'https://www.googleapis.com/auth/youtube.readonly');
  assert.equal(auth.get('response_type'), 'token');
  assert.equal(auth.get('redirect_uri'), `https://${EXTENSION_ID}.chromiumapp.org/`);

  const stored = await storage();
  assert.equal(stored['pm.meta'].by, 'pull');
  assert.equal(stored['pm.videos'].vidA.contentDetails.duration, 'PT4M20S');
  assert.equal(stored['pm.videos'].vidGone.unavailable, true);

  await row('Pulled two').locator('.pm-name').click();
  await waitFor(async () => (await tree()).includes('  V Deleted video'), 'pulled videos visible');
  await shot('4-pulled');
});

// --- runner -------------------------------------------------------------------------

async function main() {
  context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  await context.route('https://www.youtube.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    headers: { 'content-security-policy': "require-trusted-types-for 'script'" },
    body: MOCK_PAGE,
  }));
  await context.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));

  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  page = await context.newPage();
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    if (acceptDialogs) dialog.accept();
    else dialog.dismiss();
  });

  let failed = 0;
  for (const { name, fn } of steps) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}\n${String(err.stack || err).replace(/^/gm, '      ')}`);
      const file = path.join(tmp, 'failure.png');
      await page.screenshot({ path: file, fullPage: true }).catch(() => {});
      console.log(`      screenshot: ${file}`);
      break;
    }
  }
  await context.close();
  console.log(failed ? '\nE2E FAILED' : `\nAll ${steps.length} end-to-end steps passed.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  context?.close();
});
