// AnyPASS リセール監視（BMSG FES’26）→ LINE通知
// GitHub Actions 上で本物のChromeを開いたまま監視し続ける（常駐ループ版）
// 一覧は約60秒ごとにしか更新されないため、更新タイミングを学習し、その前後だけ1秒おきに集中チェックする
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
const LOOP_MINUTES = Number(process.env.LOOP_MINUTES || 330);  // 1回の実行で動き続ける時間（分）
const RELOAD_EVERY_MIN = 4;                                    // ページを開き直す間隔（分）
const ERROR_NOTIFY_AFTER = 3;                                  // 連続この回数失敗したらエラー通知
const STATE = 'state/state.json';
const LOG_DIR = 'logs';
const REFRESH_LOG = `${LOG_DIR}/checks.jsonl`;                 // 分析用：全チェックの記録
const LIST_URL = 'https://store.anypass.jp/resale-list';

// ---- 更新タイミング追跡の設定 ----
const BASE_MS = Number(process.env.INTERVAL_SEC || 10) * 1000; // 学習できていないときの間隔
const PERIOD_MS0 = Number(process.env.PERIOD_SEC || 60) * 1000; // 一覧の更新周期（初期値）
const DENSE_MS = 1000;          // 予想時刻の前後でチェックする間隔
const PRE_MS = 2000;            // 予想時刻の何ミリ秒前から集中チェックするか（幅に加算）
const POST_MS = 2000;           // 予想時刻の何ミリ秒後まで集中チェックするか（幅に加算）
const SAFETY_MS = 30000;        // 集中チェックの外でも、この間隔では必ず確認する
const DRIFT_MS_PER_CYCLE = 300; // 1周期ごとに予想の誤差幅をどれだけ広げるか（ずれ対策）
const MAX_UNCERT_MS = 8000;     // 誤差幅がこれを超えたら学習前のモード（10秒おき）に戻る
const MIN_UNCERT_MS = 300;      // 誤差幅の下限

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hms = t => new Date(t).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }) +
  '.' + String(new Date(t).getMilliseconds()).padStart(3, '0');
const sec = ms => (ms / 1000).toFixed(1) + 's';

const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return { notified: {}, lastError: '', phase: null }; }
};
const saveState = s => {
  fs.mkdirSync('state', { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s));
};
fs.mkdirSync(LOG_DIR, { recursive: true });
const logJson = obj => fs.appendFileSync(REFRESH_LOG, JSON.stringify(obj) + '\n');

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
  console.log(`[${hms(Date.now())}] ページを開く: HTTP ${res && res.status()}`);
  await page.waitForSelector('input[name="_token"]', { state: 'attached', timeout: 45000 });
}

const state = loadState();
const stats = { checks: 0, requests: 0, found: 0, maxItems: 0, errors: 0, refreshObs: 0, hits: 0, misses: 0, firstLearn: 0 };
let consecutiveErrors = 0;

// ---- 更新タイミングの推定 ----
// phase = { est: 更新が起きたと推定される時刻(ms), uncert: その誤差の半幅(ms), period: 周期(ms) }
let phase = state.phase && state.phase.est ? { ...state.phase } : null;
if (phase && !phase.period) phase.period = PERIOD_MS0;

const widthAt = t => phase ? Math.max(MIN_UNCERT_MS, phase.uncert + Math.max(0, (t - phase.est) / phase.period) * DRIFT_MS_PER_CYCLE) : Infinity;
const refreshNear = t => phase ? phase.est + Math.round((t - phase.est) / phase.period) * phase.period : null;
const refreshAfter = t => phase ? phase.est + Math.ceil((t - phase.est) / phase.period) * phase.period : null;

// 時刻 t のチェックが、予想更新時刻に対してどの位置か
function classify(t) {
  if (!phase) return { mode: 'learn', R: null, w: null };
  const w = widthAt(t);
  if (w > MAX_UNCERT_MS) return { mode: 'learn', R: null, w };
  const R = refreshNear(t);
  const inDense = t >= R - w - PRE_MS && t <= R + w + POST_MS;
  return { mode: inDense ? 'dense' : 'safety', R, w };
}

// 次のチェック時刻を決める
function planNext(now) {
  if (!phase) return now + BASE_MS;
  const w = widthAt(now);
  if (w > MAX_UNCERT_MS) return now + BASE_MS;
  const step = w > 3000 ? 2000 : DENSE_MS;
  // 今が集中チェックの範囲内か、次の範囲の開始はいつか
  const Rnear = refreshNear(now);
  if (now >= Rnear - w - PRE_MS && now <= Rnear + w + POST_MS) return now + step;
  const Rnext = refreshAfter(now + 1);
  const start = Rnext - widthAt(Rnext) - PRE_MS;
  return Math.min(start, now + SAFETY_MS);
}

// 一覧の内容が (a, b] のあいだに変わったことが分かったとき、推定を更新する
function onChange(a, b) {
  stats.refreshObs++;
  let lo = a, hi = b;
  const rec = { type: 'refresh', obsFrom: a, obsTo: b, obsWidthMs: b - a };
  if (phase) {
    const mid = (a + b) / 2;
    const k = Math.round((mid - phase.est) / phase.period);
    const predR = phase.est + k * phase.period;
    const predW = widthAt(mid);
    const ilo = Math.max(lo, predR - predW), ihi = Math.min(hi, predR + predW);
    const hit = predW <= MAX_UNCERT_MS && ilo <= ihi;
    Object.assign(rec, { predR, predW: Math.round(predW), cycles: k, hit, offsetMs: Math.round(mid - predR) });
    if (hit) {
      stats.hits++;
      lo = ilo; hi = ihi;
      // 周期の学習：前回も今回も誤差が小さいときだけ、周期を少しずつ補正する
      const newEst = (lo + hi) / 2;
      if (k >= 1 && k <= 15 && phase.uncert <= 1500 && (hi - lo) / 2 <= 1500) {
        const cand = (newEst - phase.est) / k;
        if (cand > 55000 && cand < 65000) {
          phase.period = Math.round(phase.period * 0.7 + cand * 0.3);
          rec.periodCandidate = Math.round(cand);
        }
      }
    } else if (predW <= MAX_UNCERT_MS) {
      stats.misses++;
    } else {
      stats.firstLearn++;
    }
  } else {
    stats.firstLearn++;
  }
  const est = (lo + hi) / 2;
  const uncert = Math.max(MIN_UNCERT_MS, (hi - lo) / 2);
  phase = { est, uncert, period: phase?.period || PERIOD_MS0, updatedAt: Date.now() };
  Object.assign(rec, { newEst: Math.round(est), newUncert: Math.round(uncert), period: phase.period });
  state.phase = phase;
  logJson(rec);
  console.log(`[${hms(b)}] 更新を検知: ${hms(lo)}〜${hms(hi)} の間（推定 ${hms(est)} ±${sec(uncert)}）` +
    (rec.hit === true ? ' 予想どおり' : rec.hit === false ? ` 予想外れ（${sec(rec.offsetMs)}ずれ）` : ' 初回学習') +
    ` / 周期 ${sec(phase.period)}`);
}

async function handleResult(items, tSend, tRecv, cls) {
  if (items.some(i => !i.title.includes(CFG.titleMust))) {
    throw new Error('絞り込みが効いていない可能性（BMSG以外の出品が混在）');
  }
  const available = items.filter(i => !i.purchasing);
  const wanted = available.filter(isWanted);
  stats.checks++;
  stats.maxItems = Math.max(stats.maxItems, items.length);
  const pos = cls.R ? ` / ${cls.mode} 予想との差 ${sec(tSend - cls.R)} 幅±${sec(cls.w)}` : ` / ${cls.mode}`;
  console.log(`[${hms(tSend)}] 出品 ${items.length}件 / 購入可能 ${available.length}件 / うち条件に合う ${wanted.length}件${pos}`);
  items.forEach(i => console.log('   ' + JSON.stringify({ ...i, url: i.url.split('?')[0] })));

  // 購入手続き中になった出品は通知済み記録を消す（決済されずに戻ったら再通知するため）
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
    console.log(`::notice title=通知送信::${hms(t)} ${targets.map(i => `${i.date} ${i.seat} ${i.price}`).join(' / ')}`);
    logJson({ type: 'notify', t, ids: targets.map(i => i.id) });
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

  const startAt = Date.now();
  const endAt = startAt + (TEST ? 0 : LOOP_MINUTES * 60 * 1000);
  stats.startAt = startAt;
  let lastOpen = 0;
  let prev = null; // 前回成功したチェック { sig, tSend }
  if (phase) console.log(`前回の推定を引き継ぎ: 更新 ${hms(phase.est)} ±${sec(phase.uncert)} / 周期 ${sec(phase.period)}`);

  do {
    let nextAt = Date.now() + BASE_MS;
    try {
      // ページの開き直し：時間が来ていても、集中チェックの直前なら後回しにする（最大でも8分）
      const now0 = Date.now();
      const due = now0 - lastOpen > RELOAD_EVERY_MIN * 60 * 1000;
      const nextDense = planNext(now0);
      const safeToReload = !phase || classify(now0).mode !== 'dense' && nextDense - now0 > 8000;
      if (consecutiveErrors > 0 || lastOpen === 0 || (due && safeToReload) || now0 - lastOpen > 8 * 60 * 1000) {
        await openList(page);
        lastOpen = Date.now();
        prev = null; // 開き直しの前後は比較しない（取りこぼし防止のため次回から再開）
      }

      const tSend = Date.now();
      const cls = classify(tSend);
      let r = await searchInPage(page);
      stats.requests++;
      if (r.status !== 200 || !r.hasList) {
        console.log(`[${hms(Date.now())}] 検索の応答が異常（HTTP ${r.status}）→ ページを開き直して再試行`);
        logJson({ type: 'retry', t: Date.now(), status: r.status });
        await openList(page);
        lastOpen = Date.now();
        r = await searchInPage(page);
        stats.requests++;
        if (r.status !== 200 || !r.hasList) throw new Error('検索に失敗 HTTP ' + r.status);
      }
      const tRecv = Date.now();

      const sig = r.items.map(i => i.id + (i.purchasing ? 'P' : 'A')).sort().join(',');
      const changed = prev && prev.sig !== sig;
      logJson({ type: 'check', tSend, tRecv, mode: cls.mode, predR: cls.R, w: cls.w ? Math.round(cls.w) : null, changed: !!changed, sig });
      if (changed) onChange(prev.tSend, tRecv);
      prev = { sig, tSend };

      const { items, available } = await handleResult(r.items, tSend, tRecv, cls);

      if (state.lastError) {
        state.lastError = '';
        await pushLine('✅ リセール監視が復旧しました');
      }
      consecutiveErrors = 0;
      if (TEST) {
        await pushLine(`🧪 テスト実行OK\nBMSG FES出品 ${items.length}件（うち購入可能 ${available.length}件）\n通知条件：${CFG.wantDate || '全日程'} / ${CFG.wantCount ? CFG.wantCount + '枚' : '枚数指定なし'}\n更新タイミング追跡：${phase ? `周期 ${sec(phase.period)} 誤差±${sec(widthAt(Date.now()))}` : '未学習'}`);
      }
      nextAt = planNext(Date.now());
    } catch (e) {
      const msg = String(e && e.message || e).slice(0, 300);
      consecutiveErrors++;
      stats.errors++;
      prev = null;
      console.error(`[${hms(Date.now())}] エラー(${consecutiveErrors}回連続): ${msg}`);
      logJson({ type: 'error', t: Date.now(), msg });
      if ((consecutiveErrors >= ERROR_NOTIFY_AFTER && !state.lastError) || TEST) {
        await pushLine('⚠️ リセール監視エラー: ' + msg);
        state.lastError = msg;
      }
      if (TEST) process.exitCode = 1;
      nextAt = Date.now() + BASE_MS;
    }

    // 3日以上前の通知記録は掃除して保存（途中で止まっても記録が残るよう毎回保存）
    const limit = Date.now() - 3 * 24 * 3600 * 1000;
    for (const k of Object.keys(state.notified)) if (state.notified[k] < limit) delete state.notified[k];
    state.phase = phase;
    saveState(state);

    const wait = nextAt - Date.now();
    if (!TEST && Date.now() < endAt && wait > 0) await sleep(wait);
  } while (Date.now() < endAt);
} finally {
  await browser.close();
  state.phase = phase;
  saveState(state);
  const mins = Math.max(1, (Date.now() - (stats.startAt || Date.now())) / 60000);
  const summary = `チェック ${stats.checks}回（1分あたり約${(stats.requests / mins).toFixed(1)}回）/ 最大出品数 ${stats.maxItems}件 / 通知 ${stats.found}件 / エラー ${stats.errors}回` +
    ` / 更新検知 ${stats.refreshObs}回（予想的中 ${stats.hits}・外れ ${stats.misses}・学習 ${stats.firstLearn}）` +
    (phase ? ` / 最終推定 周期 ${sec(phase.period)} 誤差±${sec(phase.uncert)}` : '');
  console.log(`::notice title=チェック結果::${summary}`);
  logJson({ type: 'summary', t: Date.now(), ...stats, phase });
}
