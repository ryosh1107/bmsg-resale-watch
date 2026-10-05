// AnyPASS リセール監視（BMSG FES’26）→ LINE通知
// GitHub Actions 上で本物のChromeを動かしてページを読む
import { chromium } from 'playwright';
import fs from 'node:fs';

const CFG = {
  artist: 'BMSG FES',
  tour: '725',                           // BMSG FES’26
  event: process.env.SEARCH_EVENT || '', // 日程を絞る場合: 1003610=10/10, 1003611=10/11, 1003612=10/12
  titleMust: 'BMSG FES',
  notifyPurchasing: process.env.NOTIFY_PURCHASING === 'true',
};
const TOKEN = process.env.LINE_TOKEN;
const USER = process.env.LINE_USER_ID;
const TEST = process.env.TEST_MODE === 'true';
const STATE = 'state/state.json';

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
  const r = await fetch('https://api.line.me/v2/bot/message/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ messages: [{ type: 'text', text }] }),
  });
  if (!r.ok) console.error('LINE送信失敗', r.status, await r.text());
}

async function fetchItems() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const probe = await browser.newPage();
    const ua = (await probe.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
    await probe.close();

    const ctx = await browser.newContext({
      userAgent: ua, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 },
    });
    const page = await ctx.newPage();
    const res = await page.goto('https://store.anypass.jp/resale-list', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('初回ステータス:', res && res.status());

    // ボット対策のチェックページが出た場合は、通過して本来のページになるまで待つ
    try {
      await page.waitForSelector('input[name="_token"]', { state: 'attached', timeout: 45000 });
    } catch {
      const snippet = (await page.content()).replace(/\s+/g, ' ').slice(0, 300);
      throw new Error('一覧ページを開けない（ボット対策の可能性）: ' + snippet);
    }

    // ページ内からサイトの絞り込み検索を実行して出品を解析
    return await page.evaluate(async (c) => {
      const tok = document.querySelector('input[name="_token"]').value;
      const fd = new URLSearchParams({
        _token: tok, mode: 'pc', free_word: '',
        search_artist: c.artist, search_event: c.event, search_tour: c.tour,
        ticket_count: '', price_min: '', price_max: '',
      });
      const r = await fetch('/resale-list', { method: 'POST', body: fd });
      const html = await r.text();
      const d = new DOMParser().parseFromString(html, 'text/html');
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
          price: price ? `${price[1]}/1枚` : '',
        };
      });
      return { status: r.status, items };
    }, CFG);
  } finally {
    await browser.close();
  }
}

const state = loadState();
try {
  const { status, items } = await fetchItems();
  if (status !== 200) throw new Error('検索に失敗 HTTP ' + status);
  if (items.some(i => !i.title.includes(CFG.titleMust))) {
    throw new Error('絞り込みが効いていない可能性（BMSG以外の出品が混在）');
  }

  const available = items.filter(i => !i.purchasing);
  console.log(`出品 ${items.length}件 / 購入可能 ${available.length}件`);
  items.forEach(i => console.log(JSON.stringify({ ...i, url: i.url.split('?')[0] })));

  if (state.lastError) {
    state.lastError = '';
    await pushLine('✅ リセール監視が復旧しました');
  }

  const targets = items.filter(i => (CFG.notifyPurchasing || !i.purchasing) && !state.notified[i.id]);
  if (targets.length) {
    const lines = targets.slice(0, 5).map(i =>
      `■ ${i.date}\n${i.seat} / ${i.price}` +
      (i.label ? `\n${i.label}` : '') +
      (i.purchasing ? '\n(購入手続き中)' : '') +
      `\n${i.url}`);
    await pushLine(`🎫 BMSG FESリセール出品 ${targets.length}件！\n\n` + lines.join('\n\n'));
    const now = Date.now();
    targets.forEach(i => { state.notified[i.id] = now; });
  }

  if (TEST) {
    await pushLine(`🧪 テスト実行OK\nBMSG FES出品 ${items.length}件（うち購入可能 ${available.length}件）`);
  }

  const limit = Date.now() - 3 * 24 * 3600 * 1000;
  for (const k of Object.keys(state.notified)) if (state.notified[k] < limit) delete state.notified[k];
} catch (e) {
  const msg = String(e && e.message || e).slice(0, 300);
  console.error(msg);
  // エラー通知は状態が変わったとき1回だけ（テスト実行時は毎回）
  if (!state.lastError || TEST) await pushLine('⚠️ リセール監視エラー: ' + msg);
  state.lastError = msg;
  if (TEST) process.exitCode = 1;
}
saveState(state);
