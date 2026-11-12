// Влиза в Ratestar, взима класацията по Google отзиви за текущата седмица (понеделник 00:00 → сега,
// + победителите от миналата) и я записва в site/data/leaderboard.json + дневен архив в site/data/history/.
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

// "YYYY-MM-DD" → моментът 00:00 по софийско време в този ден
function sofiaMidnight(ymd) {
  const utc = new Date(`${ymd}T00:00:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Sofia', timeZoneName: 'shortOffset' })
    .formatToParts(utc).find(p => p.type === 'timeZoneName').value; // "GMT+2" / "GMT+3"
  return new Date(+utc - Number(off.replace('GMT', '') || 0) * 3600e3);
}

// "YYYY-MM-DD" ден, преместен с n дни
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// Седмиците (понеделник – неделя) по софийско време
const today = sofiaDate();
const monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
const weeks = {
  week: { from: monday, to: addDays(monday, 6), start: sofiaMidnight(monday), end: new Date() },
  lastWeek: { from: addDays(monday, -7), to: addDays(monday, -1), start: sofiaMidnight(addDays(monday, -7)), end: new Date(+sofiaMidnight(monday) - 1) },
};

// Месечният пост за шофьорите (прави се всеки понеделник): класацията за месеца до неделя вечер
// и как се е променила спрямо предишния понеделник. Ако месецът е свършил през изминалата седмица —
// финалът на този месец (целият месец).
const firstOfNextMonth = ym => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 1)).toISOString().slice(0, 10);
const prevMonday = addDays(monday, -7);
const postMonth = prevMonday.slice(0, 7);
const postStart = `${postMonth}-01`;
const postEnd = [monday, firstOfNextMonth(postMonth)].sort()[0]; // изключително (00:00 този ден)
const post = {
  month: postMonth,
  final: postEnd === firstOfNextMonth(postMonth),
  from: postStart,
  to: addDays(postEnd, -1),
  daysLeft: (Date.parse(firstOfNextMonth(postMonth)) - Date.parse(postEnd)) / 864e5,
  now: { start: sofiaMidnight(postStart), end: sofiaMidnight(postEnd) },
  // седмица назад; празно, ако месецът е започнал тази седмица
  prev: prevMonday > postStart ? { start: sofiaMidnight(postStart), end: sofiaMidnight(prevMonday) } : null,
};

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

  // Броят отзиви на карта за период „от – до“ идва от същото API, което ползва таблото.
  const queries = {
    ...Object.fromEntries(Object.entries(weeks).map(([k, w]) =>
      [k, `from=${encodeURIComponent(w.start.toISOString())}&to=${encodeURIComponent(w.end.toISOString())}`])),
    thisMonth: 'interval=thisMonth', lastMonth: 'interval=lastMonth', // за по-старите версии на страницата
    today: 'interval=today', // само за проверка в лога — същото като „Today“ в таблото
  };
  const range = r => `from=${encodeURIComponent(r.start.toISOString())}&to=${encodeURIComponent(r.end.toISOString())}`;
  queries.postNow = range(post.now);
  if (post.prev) queries.postPrev = range(post.prev);
  raw = await page.evaluate(async ({ accountId, cards, queries }) => {
    const boards = {};
    for (const [key, query] of Object.entries(queries)) {
      const r = await fetch(`/api/analytics?accountId=${accountId}&${query}`);
      if (!r.ok) throw new Error(`/api/analytics ${key}: HTTP ${r.status}`);
      const j = await r.json();
      boards[key] = { total: j.reviews?.google?.periodCount ?? 0, perCard: j.reviewsPerCard ?? [] };
    }
    return { cards, boards };
  }, { accountId, cards, queries });
} finally {
  await browser.close();
}

if (Object.keys(raw.cards).length < 10) {
  throw new Error(`Намерени са само ${Object.keys(raw.cards).length} карти — вероятно Ratestar е сменил структурата.`);
}

// При равен брой отзиви по-малкият номер е по-напред — както в таблото на Ratestar.
function top(key, n) {
  const { total, perCard } = raw.boards[key];
  return {
    total,
    top: perCard
      .filter(r => r.count > 0 && raw.cards[r.cardId] != null)
      .map(r => ({ number: raw.cards[r.cardId], reviews: r.count }))
      .sort((a, b) => b.reviews - a.reviews || a.number - b.number)
      .slice(0, n)
      .map(r => ({ car: '#' + String(r.number).padStart(4, '0'), reviews: r.reviews })),
  };
}
const week = (key, n) => ({ from: weeks[key].from, to: weeks[key].to, ...top(key, n) });

// Месечният пост: топ 10 до неделя вечер + място и отзиви седмица по-рано (за стрелките ↑↓ и „+N тази седмица“)
function monthPost() {
  const ranked = key => (raw.boards[key] ? top(key, Infinity).top : []);
  const now = ranked('postNow'), before = ranked('postPrev');
  const prevRank = new Map(before.map((r, i) => [r.car, i + 1]));
  const prevCount = new Map(before.map(r => [r.car, r.reviews]));
  const prevTotal = raw.boards.postPrev?.total ?? 0;
  return {
    month: post.month, final: post.final, from: post.from, to: post.to, daysLeft: post.daysLeft,
    total: raw.boards.postNow.total,
    weekGain: raw.boards.postNow.total - prevTotal,
    drivers: now.length,
    top: now.slice(0, TOP_N).map((r, i) => ({
      ...r, rank: i + 1, prevRank: prevRank.get(r.car) ?? null, gain: r.reviews - (prevCount.get(r.car) ?? 0),
    })),
  };
}
const month = (key, ym, n) => ({ month: ym, ...top(key, n) });

const data = {
  updatedAt: new Date().toISOString(),
  week: week('week', TOP_N),
  lastWeek: week('lastWeek', 3),
  monthPost: monthPost(),
  // Месечният формат — за телевизорите, които още не са презаредили страницата след минаването на седмична класация
  thisMonth: month('thisMonth', today.slice(0, 7), TOP_N),
  lastMonth: month('lastMonth', addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7), 3),
};

const json = JSON.stringify(data, null, 2) + '\n';
await mkdir('site/data/history', { recursive: true });
await writeFile('site/data/leaderboard.json', json);
await writeFile(`site/data/history/${sofiaDate()}.json`, json);
console.log(`OK: седмица ${data.week.from} – ${data.week.to}: ${data.week.top.length} шофьори, ${data.week.total} отзива` +
  ` (днес: ${raw.boards.today.total}, миналата седмица: ${data.lastWeek.total})`);
console.log(`Месечен пост: ${data.monthPost.from} – ${data.monthPost.to}${data.monthPost.final ? ' (финал)' : ''}: ` +
  `${data.monthPost.total} отзива, +${data.monthPost.weekGain} за седмицата, ${data.monthPost.drivers} шофьори`);
