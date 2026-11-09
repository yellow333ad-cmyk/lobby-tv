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
  await page.goto(`${BASE}/en/admin`, { waitUntil: 'load' });
  // Next.js данните идват на части — изчакваме да пристигнат акаунтът и картите.
  try {
    await page.waitForFunction(() => {
      const flight = (self.__next_f || []).map(x => x[1] || '').join('');
      return /"(homeAccountId|accountId)":"[0-9a-f-]{36}"/.test(flight) && flight.includes('"externalId"');
    }, null, { timeout: 45_000 });
  } catch (e) {
    // Какво все пак има в страницата — за да се види какво е сменил Ratestar.
    const seen = await page.evaluate(() => {
      const flight = (self.__next_f || []).map(x => x[1] || '').join('');
      return {
        chunks: (self.__next_f || []).length,
        length: flight.length,
        accountKeys: [...new Set([...flight.matchAll(/"([A-Za-z]*[aA]ccount[A-Za-z]*)":/g)].map(m => m[1]))].join(','),
        cards: [...flight.matchAll(/"externalId":"/g)].length,
      };
    });
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`Таблото на Ratestar не зареди данните (адрес: ${page.url()}, данни: ${JSON.stringify(seen)}). На екрана: ${text}`);
  }

  // Картите (externalId → номер на колата) са вградени в страницата като Next.js данни,
  // а броят отзиви на карта идва от същото API, което ползва таблото.
  raw = await page.evaluate(async () => {
    const flight = (self.__next_f || []).map(x => x[1] || '').join('');
    const accountId = flight.match(/"homeAccountId":"([0-9a-f-]{36})"/)?.[1]
      ?? flight.match(/"accountId":"([0-9a-f-]{36})"/)?.[1];
    if (!accountId) throw new Error('Не намерих accountId в страницата на Ratestar.');
    const cards = {};
    for (const m of flight.matchAll(/\{[^{}]*"externalId":"[^"]+"[^{}]*\}/g)) {
      try {
        const o = JSON.parse(m[0]);
        if (o.number != null) cards[o.externalId] = o.number;
      } catch {}
    }
    const boards = {};
    for (const interval of ['thisMonth', 'lastMonth']) {
      const r = await fetch(`/api/analytics?accountId=${accountId}&interval=${interval}`);
      if (!r.ok) throw new Error(`/api/analytics ${interval}: HTTP ${r.status}`);
      const j = await r.json();
      boards[interval] = { total: j.reviews?.google?.periodCount ?? 0, perCard: j.reviewsPerCard ?? [] };
    }
    return { cards, boards };
  });
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
