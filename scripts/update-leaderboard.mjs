// Влиза в Ratestar, взима класацията по Google отзиви за текущия месец (+ шампиона на миналия)
// и я записва в site/data/leaderboard.json + дневен архив в site/data/history/.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = 'https://www.ratestar.io';
const TOP_N = 10;
const { RATESTAR_EMAIL, RATESTAR_PASSWORD } = process.env;
if (!RATESTAR_EMAIL || !RATESTAR_PASSWORD) {
  throw new Error('Липсват RATESTAR_EMAIL / RATESTAR_PASSWORD (GitHub → Settings → Secrets → Actions).');
}

// "YYYY-MM-DD" по софийско време
function sofiaDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(new Date());
}

// "YYYY-MM" на миналия месец по софийско време
function sofiaLastMonth() {
  const [y, m] = sofiaDate().split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

const browser = await chromium.launch();
let raw;
try {
  const page = await browser.newPage({ locale: 'en-US', timezoneId: 'Europe/Sofia' });
  await page.goto(`${BASE}/en/auth/login`);
  await page.fill('input[name="email"]', RATESTAR_EMAIL);
  await page.fill('input[name="password"]', RATESTAR_PASSWORD);
  try {
    await Promise.all([
      page.waitForURL(/\/admin/, { timeout: 45_000 }),
      page.click('button[type="submit"]'),
    ]);
  } catch (e) {
    // Показваме какво пише Ratestar на екрана (въведените стойности не са част от текста).
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400);
    throw new Error(`Входът в Ratestar не мина (адрес: ${page.url()}). На екрана: ${text}`);
  }
  // Акаунтът и картите (externalId → номер на колата) идват като Next.js данни: понякога вградени
  // в страницата, понякога в отделни заявки след зареждането — събираме и двете.
  const rsc = [], seenUrls = [];
  page.on('response', async res => {
    const type = res.headers()['content-type'] || '';
    seenUrls.push(`${res.status()} ${new URL(res.url()).pathname} ${type.split(';')[0]}`);
    if (type.includes('text/x-component')) rsc.push(await res.text().catch(() => ''));
  });
  await page.goto(`${BASE}/en/admin`, { waitUntil: 'load' });
  const ready = /"(homeAccountId|accountId)":"[0-9a-f-]{36}"/;
  const collect = async () =>
    (await page.evaluate(() => (self.__next_f || []).map(x => x[1] || '').join(''))) + rsc.join('');
  let flight = '';
  for (let t = 0; t < 45 && !(ready.test(flight = await collect()) && flight.includes('"externalId"')); t++) {
    if (t === 15) {
      // Същите данни, които браузърът иска при навигация в таблото
      rsc.push(await page.evaluate(() => fetch('/en/admin', { headers: { RSC: '1' } }).then(r => r.text()).catch(() => '')));
    }
    await page.waitForTimeout(1000);
  }
  if (!ready.test(flight) || !flight.includes('"externalId"')) {
    // Какво все пак има — за да се види какво е сменил Ratestar.
    const seen = {
      length: flight.length,
      rsc: rsc.map(r => r.length),
      accountKeys: [...new Set([...flight.matchAll(/"([A-Za-z]*[aA]ccount[A-Za-z]*)":/g)].map(m => m[1]))].join(','),
      cards: [...flight.matchAll(/"externalId":"/g)].length,
      urls: [...new Set(seenUrls)].filter(u => !/\.(js|css|woff2?|png|svg|ico|jpe?g|webp)\b/.test(u)).slice(0, 25),
    };
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`Таблото на Ratestar не даде данните (адрес: ${page.url()}, видяно: ${JSON.stringify(seen)}). На екрана: ${text}`);
  }

  const accountId = flight.match(/"homeAccountId":"([0-9a-f-]{36})"/)?.[1]
    ?? flight.match(/"accountId":"([0-9a-f-]{36})"/)[1];
  const cards = {};
  for (const m of flight.matchAll(/\{[^{}]*"externalId":"[^"]+"[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0]);
      if (o.number != null) cards[o.externalId] = o.number;
    } catch {}
  }

  // Броят отзиви на карта идва от същото API, което ползва таблото.
  raw = await page.evaluate(async ({ accountId, cards }) => {
    const boards = {};
    for (const interval of ['thisMonth', 'lastMonth']) {
      const r = await fetch(`/api/analytics?accountId=${accountId}&interval=${interval}`);
      if (!r.ok) throw new Error(`/api/analytics ${interval}: HTTP ${r.status}`);
      const j = await r.json();
      boards[interval] = { total: j.reviews?.google?.periodCount ?? 0, perCard: j.reviewsPerCard ?? [] };
    }
    return { cards, boards };
  }, { accountId, cards });
} finally {
  await browser.close();
}

if (Object.keys(raw.cards).length < 10) {
  throw new Error(`Намерени са само ${Object.keys(raw.cards).length} карти — вероятно Ratestar е сменил структурата.`);
}

// При равен брой отзиви по-малкият номер е по-напред — както в таблото на Ratestar.
function board(interval, month, n) {
  const { total, perCard } = raw.boards[interval];
  const top = perCard
    .filter(r => r.count > 0 && raw.cards[r.cardId] != null)
    .map(r => ({ number: raw.cards[r.cardId], reviews: r.count }))
    .sort((a, b) => b.reviews - a.reviews || a.number - b.number)
    .slice(0, n)
    .map(r => ({ car: '#' + String(r.number).padStart(4, '0'), reviews: r.reviews }));
  return { month, total, top };
}

const data = {
  updatedAt: new Date().toISOString(),
  thisMonth: board('thisMonth', sofiaDate().slice(0, 7), TOP_N),
  lastMonth: board('lastMonth', sofiaLastMonth(), 3), // за „почетно споменаване“
};

const json = JSON.stringify(data, null, 2) + '\n';
await mkdir('site/data/history', { recursive: true });
await writeFile('site/data/leaderboard.json', json);
await writeFile(`site/data/history/${sofiaDate()}.json`, json);
console.log(`OK: ${data.thisMonth.month} — ${data.thisMonth.top.length} шофьори, ${data.thisMonth.total} отзива`);
