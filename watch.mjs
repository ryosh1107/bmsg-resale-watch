// AnyPASS リセール監視（BMSG FES’26）→ LINE通知
// GitHub Actions 上で本物のChromeを開いたまま、数十秒おきにチェックし続ける（常駐ループ版）
import { chromium } from 'playwright';
import fs from 'node:fs';

const CFG = {
  artist: 'BMSG FES',
  tour: '725',                           // BMSG FES’26
  event: process.env.SEARCH_EVENT || '', // 日程を絞る場合: 1003610=10/10, 1003611=10/11, 1003612=10/12
  titleMust: 'BMSG FES',
  notifyPurchasing: process.env.NOTIFY_PURCHASING === 'true',
  wantDate: process.env.WANT_DATE || '',             // 通知する日付（例 2026/10/12）。空なら全日程
  wantCount: Number(process.env.WANT_COUNT || 0),    // 通知する枚数（例 2）。0なら枚数を問わない
};
// 通知の条件（日付・枚数）に合う出品か
const isWanted = i =>
  (!CFG.wantDate || i.date.startsWith(CFG.wantDate)) &&
  (!CFG.wantCount || i.count === CFG.wantCount);
const TOKEN = process.env.LINE_TOKEN;
const TEST = process.env.TEST_MODE === 'true';
const INTERVAL_SEC = Number(process.env.INTERVAL_SEC || 10);   // チェック間隔（秒）
const LOOP_MINUTES = Number(process.env.LOOP_MINUTES || 330);  // 1回の実行で動き続ける時間（分）
const RELOAD_EVERY_MIN = 4;                                    // ページを開き直す間隔（分）
const ERROR_NOTIFY_AFTER = 3;                                  // 連続この回数失敗したらエラー通知
const STATE = 'state/state.json';
const LIST_URL = 'https://store.anypass.jp/resale-list';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });

const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return { notified: {}, lastError: '' }; }
};
const saveState = s => {
  fs.mkdirSync('state', { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s));
};

// 公式アカウントの友だち全員に送る（broadcast）
async function pushLine(text) {
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ messages: [{ type: 'text', text }] }),
    });
    if (!r.ok) console.error('LINE送信失敗', r.status, await r.text());
  } catch (e) {
    console.error('LINE送信失敗', e.message);
  }
}

// ページ内でサイトの絞り込み検索を実行して出品を解析
async function searchInPage(page) {
  return page.evaluate(async (c) => {
    const tokEl = document.querySelector('input[name="_token"]');
    if (!tokEl) return { status: -1, items: [] };
    const fd = new URLSearchParams({
      _token: tokEl.value, mode: 'pc', free_word: '',
      search_artist: c.artist, search_event: c.event, search_tour: c.tour,
      ticket_count: '', price_min: '', price_max: '',
    });
    const r = await fetch('/resale-list', { method: 'POST', body: fd });
    const html = await r.text();
    const d = new DOMParser().parseFromString(html, 'text/html');
    const hasList = !!d.querySelector('input[name="_token"]'); // 本来の一覧ページが返ってきたか
    const items = [...d.querySelectorAll('a.resale-list-item')].map(a => {
      const t = s => (a.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim();
      const text = a.textContent.replace(/\s+/g, ' ');
      const seat = text.match(/(\S+)\s*×\s*(\d+)\s*枚/);
      const price = text.match(/(¥[\d,]+)\s*\/\s*1\s*枚/);
      const href = a.getAttribute('href') || '';
      return {
        id: (href.match(/\/resale\/(\d+)/) || [])[1] || href,
        url: new URL(href, location.origin).href,
        purchasing: /購入手続き中/.test(text),
        label: t('.fc-label-label'),
        title: t('.title'),
        date: t('.date'),
        seat: seat ? `${seat[1]} ×${seat[2]}枚` : '',
        count: seat ? Number(seat[2]) : 0,
        price: price ? `${price[1]}/1枚` : '',
      };
    });
    return { status: r.status, hasList, items };
  }, CFG);
}

// 一覧ページを開く（ボット対策のチェックページが出たら通過するまで待つ）
async function openList(page) {
  const res = await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[${now()}] ページを開く: HTTP ${res && res.status()}`);
  await page.waitForSelector('input[name="_token"]', { state: 'attached', timeout: 45000 });
}

const state = loadState();
const stats = { checks: 0, found: 0, maxItems: 0, errors: 0 };
let consecutiveErrors = 0;

async function handleResult(items) {
  if (items.some(i => !i.title.includes(CFG.titleMust))) {
    throw new Error('絞り込みが効いていない可能性（BMSG以外の出品が混在）');
  }
  const available = items.filter(i => !i.purchasing);
  stats.checks++;
  stats.maxItems = Math.max(stats.maxItems, items.length);
  const wanted = available.filter(isWanted);
  console.log(`[${now()}] 出品 ${items.length}件 / 購入可能 ${available.length}件 / うち条件に合う ${wanted.length}件`);
  items.forEach(i => console.log('   ' + JSON.stringify({ ...i, url: i.url.split('?')[0] })));

  // 購入手続き中になった出品は通知済み記録を消す（約15分後に再放出されたら再通知するため）
  items.filter(i => i.purchasing).forEach(i => { delete state.notified[i.id]; });

  const targets = items.filter(i => isWanted(i) && (CFG.notifyPurchasing || !i.purchasing) && !state.notified[i.id]);
  if (targets.length) {
    const lines = targets.slice(0, 5).map(i =>
      `■ ${i.date}\n${i.seat} / ${i.price}` +
      (i.label ? `\n${i.label}` : '') +
      (i.purchasing ? '\n(購入手続き中)' : '') +
      `\n${i.url}`);
    await pushLine(`🎫 BMSG FESリセール出品 ${targets.length}件！今すぐ！\n\n` + lines.join('\n\n'));
    const t = Date.now();
    targets.forEach(i => { state.notified[i.id] = t; });
    stats.found += targets.length;
    console.log(`::notice title=通知送信::${now()} ${targets.map(i => `${i.date} ${i.seat} ${i.price}`).join(' / ')}`);
  }
  return { items, available };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const probe = await browser.newPage();
  const ua = (await probe.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
  await probe.close();
  const ctx = await browser.newContext({
    userAgent: ua, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  const endAt = Date.now() + (TEST ? 0 : LOOP_MINUTES * 60 * 1000);
  let lastOpen = 0;

  do {
    const loopStart = Date.now();
    try {
      // 定期的に、または前回失敗していたらページを開き直す
      if (Date.now() - lastOpen > RELOAD_EVERY_MIN * 60 * 1000 || consecutiveErrors > 0) {
        await openList(page);
        lastOpen = Date.now();
      }
      let r = await searchInPage(page);
      if (r.status !== 200 || !r.hasList) {
        // トークン切れ・ボット対策の再チェックなど → ページを開き直して1回だけやり直す
        console.log(`[${now()}] 検索の応答が異常（HTTP ${r.status}）→ ページを開き直して再試行`);
        await openList(page);
        lastOpen = Date.now();
        r = await searchInPage(page);
        if (r.status !== 200 || !r.hasList) throw new Error('検索に失敗 HTTP ' + r.status);
      }
      const { items, available } = await handleResult(r.items);

      if (state.lastError) {
        state.lastError = '';
        await pushLine('✅ リセール監視が復旧しました');
      }
      consecutiveErrors = 0;
      if (TEST) {
        await pushLine(`🧪 テスト実行OK\nBMSG FES出品 ${items.length}件（うち購入可能 ${available.length}件）\n通知条件：${CFG.wantDate || '全日程'} / ${CFG.wantCount ? CFG.wantCount + '枚' : '枚数指定なし'}\nチェック間隔 ${INTERVAL_SEC}秒`);
      }
    } catch (e) {
      const msg = String(e && e.message || e).slice(0, 300);
      consecutiveErrors++;
      stats.errors++;
      console.error(`[${now()}] エラー(${consecutiveErrors}回連続): ${msg}`);
      if ((consecutiveErrors >= ERROR_NOTIFY_AFTER && !state.lastError) || TEST) {
        await pushLine('⚠️ リセール監視エラー: ' + msg);
        state.lastError = msg;
      }
      if (TEST) process.exitCode = 1;
    }

    // 3日以上前の通知記録は掃除して保存（途中で止まっても記録が残るよう毎回保存）
    const limit = Date.now() - 3 * 24 * 3600 * 1000;
    for (const k of Object.keys(state.notified)) if (state.notified[k] < limit) delete state.notified[k];
    saveState(state);

    const wait = INTERVAL_SEC * 1000 - (Date.now() - loopStart);
    if (!TEST && Date.now() < endAt && wait > 0) await sleep(wait);
  } while (Date.now() < endAt);
} finally {
  await browser.close();
  saveState(state);
  console.log(`::notice title=チェック結果::チェック ${stats.checks}回 / 最大出品数 ${stats.maxItems}件 / 通知 ${stats.found}件 / エラー ${stats.errors}回`);
}
