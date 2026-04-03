// ── IPL ARB PROXY SERVER v4 ──
// Fixes: session persistence so rebel777 login survives across runs.
//
// FIRST TIME SETUP:
//   1. node proxy.js
//   2. Open http://localhost:3000/login  ← opens a VISIBLE browser window
//   3. Log into rebel777 manually in that window
//   4. Click "Done" or visit http://localhost:3000/save-session
//   5. Session saved to rebel777-session.json — all future runs reuse it
//
// NORMAL USAGE (after first login):
//   node proxy.js  →  open http://localhost:3000

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
let SCRAPE_INTERVAL = 1000;
const RENDER_WAIT_MS = 20000;
const SESSION_FILE = path.join(__dirname, 'rebel777-session.json');
const LOGIN_ORIGIN = 'https://rebel777.co';

// ─────────────────────────────────────────────────────────
// DEPENDENCIES
// ─────────────────────────────────────────────────────────
let WebSocketServer;
try { WebSocketServer = require('ws').Server; }
catch { console.error('[FATAL] Run: npm install ws'); process.exit(1); }

let playwright;
try { playwright = require('playwright'); }
catch { console.error('[FATAL] Run: npm install playwright && npx playwright install chromium'); process.exit(1); }

// ─────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────
let browser = null;   // headless scraping browser
let loginBrowser = null;   // visible login browser (temporary)
let loginPage = null;
let page = null;
let currentUrl = '';
let lastOdds = null;
let scrapeTimer = null;
let isScraping = false;
let wsClients = new Set();

// ─────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────
function broadcast(data) {
    const msg = JSON.stringify(data);
    wsClients.forEach(ws => { try { if (ws.readyState === 1) ws.send(msg); } catch { } });
}
function log(tag, msg) {
    console.log(`[${tag}] ${new Date().toLocaleTimeString()} — ${msg}`);
}
function hasSession() {
    return fs.existsSync(SESSION_FILE);
}

// ─────────────────────────────────────────────────────────
// SESSION: save & load
// ─────────────────────────────────────────────────────────
async function saveSession(ctx) {
    const storage = await ctx.storageState();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(storage, null, 2));
    log('SESSION', `Saved to ${SESSION_FILE}`);
}

function loadSessionOptions() {
    if (!hasSession()) return {};
    try {
        return { storageState: JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) };
    } catch {
        return {};
    }
}

// ─────────────────────────────────────────────────────────
// LOGIN FLOW — opens a visible browser window
// ─────────────────────────────────────────────────────────
async function startLogin(res) {
    // Close any existing login browser
    if (loginBrowser) { await loginBrowser.close().catch(() => { }); loginBrowser = null; loginPage = null; }

    log('LOGIN', 'Opening visible browser for manual login...');
    loginBrowser = await playwright.chromium.launch({
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
    });

    const ctx = await loginBrowser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
    });

    await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    loginPage = await ctx.newPage();
    await loginPage.goto(LOGIN_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 20000 });

    log('LOGIN', 'Browser opened — log in, then visit http://localhost:3000/save-session');

    if (res) {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
        res.end(`
            <html><body style="font-family:monospace;background:#07090f;color:#b8cae8;padding:30px">
            <h2 style="color:#00d47e">✓ Login browser opened</h2>
            <p>A Chromium window has opened. Log into rebel777 in that window.</p>
            <p>When you are fully logged in and can see the odds, click below:</p>
            <br>
            <a href="/save-session" style="background:#6c63ff;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;font-size:14px">
                ✓ I'm logged in — Save Session
            </a>
            <br><br>
            <p style="color:#4a5a72;font-size:12px">Session will be saved to rebel777-session.json and reused automatically.</p>
            </body></html>
        `);
    }
}

async function saveSessionAndClose(res) {
    if (!loginBrowser || !loginPage) {
        if (res) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'No login browser open. Visit /login first.' })); }
        return;
    }

    try {
        const ctx = loginPage.context();
        await saveSession(ctx);
        log('SESSION', 'Session saved successfully ✓');

        if (res) {
            res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
            res.end(`
                <html><body style="font-family:monospace;background:#07090f;color:#b8cae8;padding:30px">
                <h2 style="color:#00d47e">✓ Session Saved!</h2>
                <p>rebel777-session.json written. You can close this tab.</p>
                <p>Now go to your tool and click <b style="color:#ffd44a">START</b> — it will use your saved login.</p>
                <br>
                <p style="color:#4a5a72;font-size:12px">You won't need to log in again unless your session expires.</p>
                </body></html>
            `);
        }

        // Close login browser after short delay
        setTimeout(async () => {
            await loginBrowser.close().catch(() => { });
            loginBrowser = null; loginPage = null;
            log('LOGIN', 'Login browser closed');
        }, 2000);

    } catch (e) {
        log('SESSION-ERR', e.message);
        if (res) { res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: e.message })); }
    }
}

// ─────────────────────────────────────────────────────────
// CORE SCRAPER — tuned to rebel777 DOM
// ─────────────────────────────────────────────────────────
async function scrapeOdds(pg) {
    return await pg.evaluate(() => {

        function parseCell(div) {
            const span = div.querySelector('[class="d-block odds"], [class*="d-block"][class*="odds"], span.odds');
            if (!span) return null;
            const odds = parseFloat(span.innerText.trim());
            if (isNaN(odds) || odds <= 1 || odds > 1000) return null;
            const lines = div.innerText.trim().split(/\s*\n\s*/);
            const size = lines.length > 1 ? parseFloat(lines[lines.length - 1].replace(/[^0-9.]/g, '')) || 0 : 0;
            return { odds, size };
        }

        const results = [];

        // Strategy 1: runner rows with bl-box cells
        const runnerRows = document.querySelectorAll(
            '[class*="runner-row"], [class*="brow"], [class*="market-runner"], [class*="runnerRow"]'
        );
        runnerRows.forEach(row => {
            const cells = row.querySelectorAll('[class*="bl-box"]');
            if (!cells.length) return;
            const nameEl = row.querySelector(
                '[class*="runner-name"], [class*="runnerName"], [class*="team-name"], [class*="teamName"], .btn, b, strong'
            );
            const name = nameEl?.innerText.trim().slice(0, 60);
            if (!name || name.length < 2) return;
            const back = [], lay = [];
            cells.forEach(cell => {
                const cls = cell.className || '';
                const c = parseCell(cell);
                if (!c) return;
                if (cls.includes('lay')) lay.push(c);
                else if (cls.includes('back')) back.push(c);
            });
            if (back.length || lay.length)
                results.push({ name, back: back.slice(0, 3), lay: lay.slice(0, 3) });
        });
        if (results.length >= 2) return results.slice(0, 2);

        // Strategy 2: global bl-box scan grouped by team name
        const allCells = Array.from(document.querySelectorAll('[class*="bl-box"]'));
        if (!allCells.length) return [];
        const nameEls = Array.from(document.querySelectorAll(
            '[class*="team"], [class*="runner"], [class*="selection"], [class*="player"]'
        )).map(el => el.innerText.trim()).filter(t => t.length > 2 && t.length < 60 && !/^\d/.test(t));
        const teams = [...new Set(nameEls)].slice(0, 6);
        for (let i = 0; i < (teams.length || 2); i++) {
            const chunk = allCells.slice(i * 6, i * 6 + 6);
            if (!chunk.length) break;
            const back = [], lay = [];
            chunk.forEach(cell => {
                const cls = cell.className || '';
                const c = parseCell(cell);
                if (!c) return;
                if (cls.includes('lay')) lay.push(c);
                else if (cls.includes('back')) back.push(c);
                else if (back.length < 3) back.push(c);
                else lay.push(c);
            });
            if (back.length || lay.length)
                results.push({ name: teams[i] || `Runner ${i + 1}`, back: back.slice(0, 3), lay: lay.slice(0, 3) });
        }
        if (results.length >= 2) return results.slice(0, 2);

        // Strategy 3: bare odds spans
        const oddsSpans = Array.from(document.querySelectorAll('[class="d-block odds"], [class*="d-block"][class*="odds"]'));
        if (!oddsSpans.length) return [];
        const fallbackNames = Array.from(document.querySelectorAll('h4,h5,h6,[class*="title"]'))
            .map(el => el.innerText.trim()).filter(t => t.length > 2 && !/^\d/.test(t)).slice(0, 4);
        const perRunner = Math.floor(oddsSpans.length / Math.max(fallbackNames.length, 2));
        for (let i = 0; i < Math.max(fallbackNames.length, 2); i++) {
            const chunk = oddsSpans.slice(i * perRunner, (i + 1) * perRunner);
            const parsed = chunk.map(sp => {
                const odds = parseFloat(sp.innerText.trim());
                const lines = sp.parentElement?.innerText?.trim().split(/\n/) || [];
                const size = lines.length > 1 ? parseFloat(lines[lines.length - 1].replace(/[^0-9.]/g, '')) || 0 : 0;
                return { odds, size };
            }).filter(o => o.odds > 1 && o.odds < 1000);
            const mid = Math.floor(parsed.length / 2);
            if (parsed.slice(0, mid).length)
                results.push({ name: fallbackNames[i] || `Runner ${i + 1}`, back: parsed.slice(0, mid), lay: parsed.slice(mid) });
        }
        return results.slice(0, 2);
    });
}

// ─────────────────────────────────────────────────────────
// POLL LOOP
// ─────────────────────────────────────────────────────────
async function doPoll() {
    if (!page || isScraping) return;
    isScraping = true;
    try {
        const runners = await scrapeOdds(page);

        if (!runners || runners.length < 2) {
            const snap = await page.evaluate(() => {
                const boxes = document.querySelectorAll('[class*="bl-box"]');
                const spans = document.querySelectorAll('[class="d-block odds"]');
                return {
                    blBoxCount: boxes.length,
                    oddsSpanCount: spans.length,
                    firstBoxHtml: boxes[0]?.outerHTML?.slice(0, 300) || 'none',
                    pageTitle: document.title,
                    url: location.href,
                    isLoginPage: document.title.toLowerCase().includes('login') ||
                        !!document.querySelector('[class*="login"], [class*="signin"], input[type="password"]'),
                };
            });
            log('POLL', `No odds — bl-boxes:${snap.blBoxCount} spans:${snap.oddsSpanCount} title:"${snap.pageTitle}" loginPage:${snap.isLoginPage}`);

            if (snap.isLoginPage) {
                broadcast({ type: 'error', msg: '⚠️ Session expired — visit http://localhost:3000/login to re-authenticate' });
                // Clear saved session so next start triggers fresh login
                if (hasSession()) { fs.unlinkSync(SESSION_FILE); log('SESSION', 'Expired session deleted'); }
            } else {
                broadcast({ type: 'debug', data: snap });
            }
            isScraping = false;
            return;
        }

        const changed = JSON.stringify(runners) !== JSON.stringify(lastOdds);
        if (changed) {
            lastOdds = runners;
            broadcast({ type: 'odds', data: { runners, _source: 'rebel777', _ts: Date.now() } });
            log('POLL', `✓ ${runners.map(r => r.name).join(' vs ')} → ${wsClients.size} client(s)`);
        } else {
            broadcast({ type: 'ping', ts: Date.now() });
        }
    } catch (e) {
        log('POLL-ERR', e.message);
        broadcast({ type: 'error', msg: e.message });
    }
    isScraping = false;
}

// ─────────────────────────────────────────────────────────
// START SCRAPING BROWSER (headless, with saved session)
// ─────────────────────────────────────────────────────────
async function startBrowser(targetUrl) {
    // Check session first
    if (!hasSession()) {
        broadcast({ type: 'error', msg: '⚠️ No session found. Visit http://localhost:3000/login to log in first.' });
        log('SESSION', 'No rebel777-session.json — login required');
        return;
    }

    if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null; }
    if (currentUrl !== targetUrl && page) { await page.close().catch(() => { }); page = null; }
    currentUrl = targetUrl;

    if (!browser) {
        log('BROWSER', 'Launching headless Chromium...');
        browser = await playwright.chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security',
            ]
        });
        browser.on('disconnected', () => {
            log('BROWSER', 'Crashed — will relaunch on next call');
            browser = null; page = null;
        });
    }

    if (!page) {
        log('BROWSER', `Opening: ${targetUrl}`);
        broadcast({ type: 'status', msg: 'Opening rebel777 with saved session...', state: 'loading' });

        // ← KEY FIX: inject saved cookies + localStorage into the new context
        const sessionOpts = loadSessionOptions();
        const ctx = await browser.newContext({
            ...sessionOpts,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            viewport: { width: 1366, height: 768 },
            locale: 'en-IN',
            timezoneId: 'Asia/Kolkata',
            extraHTTPHeaders: {
                'Accept-Language': 'en-IN,en;q=0.9',
                'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
            }
        });

        page = await ctx.newPage();

        // Trigger re-poll immediately on any WebSocket frame (rebel777 pushes live odds via WS)
        page.on('websocket', ws => {
            log('WS-DETECT', ws.url().slice(0, 80));
            ws.on('framereceived', () => setTimeout(doPoll, 300));
        });

        try {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
            log('BROWSER', `Loaded — waiting for odds elements (up to ${RENDER_WAIT_MS / 1000}s)...`);
            broadcast({ type: 'status', msg: 'Page loaded — waiting for odds to render...', state: 'loading' });

            await page.waitForSelector('span.odds, [class="d-block odds"], [class*="bl-box"]', { timeout: RENDER_WAIT_MS })
                .catch(() => log('WAIT', 'Selector timeout — scraping anyway'));

            broadcast({ type: 'status', msg: 'Odds elements detected — live!', state: 'ready' });
        } catch (e) {
            broadcast({ type: 'error', msg: `Page load failed: ${e.message}` });
            page = null; return;
        }
    }

    await doPoll();
    scrapeTimer = setInterval(doPoll, SCRAPE_INTERVAL);
    log('POLL', `Running every ${SCRAPE_INTERVAL / 1000}s`);
}

async function stopScraper() {
    if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null; }
    if (page) { await page.close().catch(() => { }); page = null; }
    lastOdds = null;
    broadcast({ type: 'status', msg: 'Scraper stopped', state: 'idle' });
    log('SCRAPER', 'Stopped');
}

// ─────────────────────────────────────────────────────────
// CHROMIUM FETCH — uses real Chrome TLS fingerprint (bypasses Cloudflare)
// Spins up a minimal context, does fetch() inside the page, returns JSON
// ─────────────────────────────────────────────────────────
const POLY_WORKER = 'https://ravi.ravisainagendra386-rs.workers.dev';

function workerFetch(targetUrl, res) {
    const relayUrl = `${POLY_WORKER}?url=${encodeURIComponent(targetUrl)}`;
    const parsed = new URL(relayUrl);
    const req = https.request({
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Connection': 'close' },
        timeout: 10000,
    }, apiRes => {
        res.writeHead(apiRes.statusCode || 200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
        });
        apiRes.pipe(res);
        apiRes.on('error', () => { try { res.end(); } catch { } });
    });
    req.on('timeout', () => { req.destroy(); try { res.writeHead(504, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Worker timeout' })); } catch { } });
    req.on('error', e => { log('WORKER-ERR', e.message); try { res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: e.message })); } catch { } });
    req.end();
}

let chromiumFetchBrowser = null;

async function chromiumFetch(targetUrl, res) {
    try {
        // Launch or reuse a separate lightweight browser for API fetches
        if (!chromiumFetchBrowser) {
            chromiumFetchBrowser = await playwright.chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
                ignoreDefaultArgs: ['--enable-automation'],
            });
            chromiumFetchBrowser.on('disconnected', () => { chromiumFetchBrowser = null; });
        }
        const ctx = await chromiumFetchBrowser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            locale: 'en-US',
        });
        const pg = await ctx.newPage();
        // Use page.evaluate to run fetch() inside Chrome — real TLS fingerprint
        const result = await pg.evaluate(async (url) => {
            try {
                const r = await fetch(url, {
                    headers: {
                        'Accept': 'application/json',
                        'Accept-Language': 'en-US,en;q=0.9',
                    }
                });
                const text = await r.text();
                return { ok: r.ok, status: r.status, body: text };
            } catch (e) {
                return { ok: false, status: 0, body: JSON.stringify({ error: e.message }) };
            }
        }, targetUrl);
        await ctx.close();

        res.writeHead(result.ok ? 200 : result.status, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
        });
        res.end(result.body);
        log('CHROME-FETCH', `✓ ${targetUrl.slice(0, 70)}`);
    } catch (e) {
        log('CHROME-FETCH-ERR', e.message);
        try {
            res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: e.message }));
        } catch { }
    }
}

// ─────────────────────────────────────────────────────────
// PROXY FETCH (Polymarket / direct JSON APIs)
// ─────────────────────────────────────────────────────────
function proxyFetch(targetUrl, res) {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const agent = isHttps ? new https.Agent({
        rejectUnauthorized: false,
        keepAlive: false,
        timeout: 15000,
        servername: parsed.hostname,   // SNI — required by Cloudflare/Polymarket
    }) : null;

    const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Encoding': 'identity',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'close',
        },
        timeout: 15000,
        ...(agent ? { agent } : {}),
    };

    const req = lib.request(options, apiRes => {
        res.writeHead(apiRes.statusCode || 200, {
            'Content-Type': apiRes.headers['content-type'] || 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
        });
        apiRes.pipe(res);
        apiRes.on('error', () => { try { res.end(); } catch { } });
    });
    req.on('timeout', () => {
        req.destroy();
        try { res.writeHead(504, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Upstream timeout' })); } catch { }
    });
    req.on('error', e => {
        log('PROXY-ERR', `${targetUrl.slice(0, 80)} — ${e.message}`);
        try { res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: e.message })); } catch { }
    });
    req.end();
}

// ─────────────────────────────────────────────────────────
// HTTP SERVER
// ─────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
        res.end(); return;
    }

    // ── /login — open visible browser for manual login ──
    if (parsed.pathname === '/login') {
        startLogin(res).catch(e => { log('LOGIN-ERR', e.message); res.writeHead(500); res.end(e.message); });
        return;
    }

    // ── /save-session — save cookies after manual login ──
    if (parsed.pathname === '/save-session') {
        saveSessionAndClose(res).catch(e => { log('SAVE-ERR', e.message); res.writeHead(500); res.end(e.message); });
        return;
    }

    // ── /session-status — check if session exists ──
    if (parsed.pathname === '/session-status') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ hasSession: hasSession(), file: SESSION_FILE }));
        return;
    }

    // ── /start-rebel777?url=... ──
    if (parsed.pathname === '/start-rebel777') {
        const target = parsed.searchParams.get('url');
        if (!target) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Missing ?url=' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, msg: 'Starting...' }));
        startBrowser(target).catch(e => log('ERR', e.message));
        return;
    }

    // ── /stop-rebel777 ──
    if (parsed.pathname === '/stop-rebel777') {
        stopScraper().catch(() => { });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // ── /set-interval?ms=5000 ──
    if (parsed.pathname === '/set-interval') {
        const ms = parseInt(parsed.searchParams.get('ms'));
        if (ms >= 1000 && ms <= 60000) {
            SCRAPE_INTERVAL = ms;
            if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = page ? setInterval(doPoll, ms) : null; }
            log('INTERVAL', `Poll rate → ${ms}ms`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ ok: true, ms }));
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'ms must be 1000–60000' }));
        }
        return;
    }

    // ── /debug ──
    if (parsed.pathname === '/debug') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ hasSession: hasSession(), lastOdds, wsClients: wsClients.size, currentUrl, isScraping, scrapeInterval: SCRAPE_INTERVAL }, null, 2));
        return;
    }

    // ── /poly-fetch?url=... — uses headless Chrome TLS fingerprint to bypass Cloudflare ──
    if (parsed.pathname === '/poly-fetch') {
        const target = parsed.searchParams.get('url');
        if (!target) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Missing ?url=' })); return;
        }
        workerFetch(target, res); return;
    }

    // ── /proxy?url=... ──
    if (parsed.pathname === '/proxy') {
        const target = parsed.searchParams.get('url');
        if (!target) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Missing ?url=' })); return; }
        proxyFetch(target, res); return;
    }

    // ── / → serve HTML ──
    if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
        const htmlPath = path.join(__dirname, 'decimal-bot.html');
        if (fs.existsSync(htmlPath)) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(htmlPath)); }
        else { res.writeHead(404); res.end('decimal-bot.html not found in the same folder'); }
        return;
    }

    res.writeHead(404); res.end('Not found');
});

// ─────────────────────────────────────────────────────────
// WEBSOCKET SERVER
// ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
    wsClients.add(ws);
    log('WS', `Client connected (${wsClients.size} total)`);

    // Tell client immediately if session is missing
    if (!hasSession()) {
        ws.send(JSON.stringify({ type: 'error', msg: '⚠️ No session — visit http://localhost:3000/login first' }));
    } else if (lastOdds) {
        ws.send(JSON.stringify({ type: 'odds', data: { runners: lastOdds, _source: 'rebel777', _ts: Date.now() } }));
    } else {
        ws.send(JSON.stringify({ type: 'status', msg: 'Connected — paste rebel777 URL and click START', state: 'idle' }));
    }

    ws.on('close', () => { wsClients.delete(ws); log('WS', `Disconnected (${wsClients.size} total)`); });
    ws.on('error', () => wsClients.delete(ws));
});

// ─────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Closing...');
    if (scrapeTimer) clearInterval(scrapeTimer);
    if (browser) await browser.close().catch(() => { });
    if (loginBrowser) await loginBrowser.close().catch(() => { });
    process.exit(0);
});

// ─────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
    const sessionStatus = hasSession() ? '✓ Session found — ready to scrape' : '⚠ No session — open /login first';
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║   IPL Arb Proxy v4  —  Session-Persistent Edition            ║
╠══════════════════════════════════════════════════════════════╣
║  UI:            http://localhost:${PORT}                        ║
║  Login:         http://localhost:${PORT}/login                  ║
║  Save session:  http://localhost:${PORT}/save-session           ║
║  Debug:         http://localhost:${PORT}/debug                  ║
╠══════════════════════════════════════════════════════════════╣
║  ${sessionStatus.padEnd(58)}║
╚══════════════════════════════════════════════════════════════╝
`);

    if (!hasSession()) {
        console.log('  👉 First time setup: open http://localhost:3000/login in your browser\n');
    }
});



// ─────────────────────────────────────────────────────────

//1. node proxy.js
//2. Open http://localhost:3000/login  ← opens a VISIBLE Chromium window
//3. Log into rebel777 in that window normally
//4. Once you can see match odds, go to http://localhost:3000/save-session
//5. Done — rebel777-session.json is saved to disk

// ─────────────────────────────────────────────────────────