// Общая логика бота «Подписчик»: Telegram, база Neon (по HTTP), даты, разбор текста.
// Без внешних зависимостей — собирать и устанавливать ничего не нужно.

const env = (k) => process.env[k] || '';

/* ───────── Telegram ───────── */
export async function tg(method, body = {}) {
  const r = await fetch(`https://api.telegram.org/bot${env('BOT_TOKEN')}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error('telegram', method, j.description || r.status);
  return j;
}
export const send = (chat_id, text, extra = {}) =>
  tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ───────── База Neon (SQL поверх HTTP, один запрос за раз) ───────── */
export async function q(text, params = []) {
  const cs = env('DATABASE_URL').trim().replace(/-pooler(?=\.)/, '');
  const host = new URL(cs.replace(/^postgres(ql)?:/, 'https:')).host;
  const r = await fetch(`https://${host}/sql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Neon-Connection-String': cs,
      'Neon-Raw-Text-Output': 'true',
      'Neon-Array-Mode': 'true',
    },
    body: JSON.stringify({ query: text, params: params.map((p) => (p == null ? null : String(p))) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('db: ' + (j.message || r.status));
  const names = (j.fields || []).map((f) => f.name);
  return (j.rows || []).map((row) => (Array.isArray(row) ? Object.fromEntries(row.map((v, i) => [names[i], v])) : row));
}

export const SCHEMA = [
  `create table if not exists users(
     chat_id bigint primary key,
     tz text not null default 'Europe/Stockholm',
     notify_hour int not null default 9,
     offsets text not null default '3,1,0',
     currency text not null default 'SEK',
     state text,
     last_update bigint not null default 0)`,
  `create table if not exists subs(
     id serial primary key,
     chat_id bigint not null,
     name text not null,
     amount numeric(12,2) not null,
     currency text not null,
     next_date date not null,
     anchor_day int not null,
     period text not null default 'month',
     trial int not null default 0,
     notified text not null default '')`,
  `create index if not exists subs_chat on subs(chat_id)`,
];

/* ───────── Даты (всё в формате YYYY-MM-DD, без часовых поясов) ───────── */
const D = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const S = (t) => new Date(t).toISOString().slice(0, 10);
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // дней в месяце (m: 1–12)
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const mk = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= dim(y, m) ? ymd(y, m, d) : null);

export const diffDays = (a, b) => Math.round((D(b) - D(a)) / 864e5); // b − a

export function addPeriod(date, period, anchor) {
  if (period === 'week') return S(D(date) + 7 * 864e5);
  let [y, m] = date.split('-').map(Number);
  if (period === 'year') y += 1;
  else { m += 1; if (m > 12) { m = 1; y += 1; } }
  return ymd(y, m, Math.min(anchor, dim(y, m)));
}
export function roll(date, period, anchor, today) {
  while (date < today) date = addPeriod(date, period, anchor);
  return date;
}

export function validTz(tz) {
  try { return new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone; } catch { return null; }
}
export function localNow(tz, now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).map((x) => [x.type, x.value]));
  return { today: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

/* ───────── Разбор текста ───────── */
export function parseDate(text, today) {
  const t = text.trim().toLowerCase();
  if (t === 'сегодня' || t === 'today') return today;
  if (t === 'завтра' || t === 'tomorrow') return S(D(today) + 864e5);
  const [ty, tm] = today.split('-').map(Number);
  let m;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return mk(+m[1], +m[2], +m[3]);
  if ((m = t.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/))) return mk(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  if ((m = t.match(/^(\d{1,2})[./](\d{1,2})$/))) {
    let r = mk(ty, +m[2], +m[1]);
    if (r && r < today) r = mk(ty + 1, +m[2], +m[1]);
    return r;
  }
  if ((m = t.match(/^(\d{1,2})(?:-?го)?$/))) { // просто число месяца → ближайшая такая дата
    const d = +m[1];
    let y = ty, mo = tm;
    for (let i = 0; i < 14 && d >= 1 && d <= 31; i++) {
      const r = mk(y, mo, d);
      if (r && r >= today) return r;
      if (++mo > 12) { mo = 1; y++; }
    }
  }
  return null;
}

const CUR = { $: 'USD', '€': 'EUR', '£': 'GBP', '₽': 'RUB', руб: 'RUB', р: 'RUB', kr: 'SEK', кр: 'SEK', крон: 'SEK' };
export function parseAmount(tok) {
  const m = tok.match(/^([$€£₽])?(\d+(?:[.,]\d{1,2})?)([$€£₽])?$/);
  if (!m) return null;
  const amount = parseFloat(m[2].replace(',', '.'));
  return amount > 0 ? { amount, cur: CUR[m[1] || m[3]] || null } : null;
}

const STOP = new Set(['в', 'на', 'число', 'числа', 'каждое', 'каждый', 'раз', 'за', 'по', 'потом', 'затем']);
// «Netflix 9.99 USD 15 месяц триал» → {name, amount, currency, date, period, trial}
// mode: 'full' — название + сумма + остальное; 'amount' — сумма + остальное; 'tail' — только валюта/дата/период/триал
export function parseQuick(text, today, mode = 'full') {
  const toks = text.trim().split(/\s+/).filter(Boolean);
  const out = {};
  let rest = toks;
  if (mode === 'full') {
    const ai = toks.findIndex((t, k) => k > 0 && parseAmount(t)); // имя не может быть пустым
    if (ai < 0) { out.name = toks.join(' '); return out; }
    out.name = toks.slice(0, ai).join(' ');
    rest = toks.slice(ai);
  }
  if (mode !== 'tail') {
    const a = parseAmount(rest[0] || '');
    if (!a) return out;
    out.amount = a.amount;
    if (a.cur) out.currency = a.cur;
    rest = rest.slice(1);
  }
  for (const t of rest) {
    const l = t.toLowerCase();
    if (STOP.has(l)) continue;
    if (CUR[l]) out.currency = CUR[l];
    else if (/^[a-z]{3}$/.test(l)) out.currency = l.toUpperCase();
    else if (/^(триал|trial|пробн)/.test(l)) out.trial = 1;
    else if (/^(еже)?(мес|month)/.test(l)) out.period = 'month';
    else if (/^(еже)?(год|year|annual)/.test(l)) out.period = 'year';
    else if (/^(еже)?(недел|week)/.test(l)) out.period = 'week';
    else if (!out.date) { const d = parseDate(t, today); if (d) out.date = d; }
  }
  if (out.period && out.trial == null) out.trial = 0;
  return out;
}

export const parseOffsets = (s) =>
  [...new Set(String(s).split(/[,\s]+/).filter((x) => /^\d+$/.test(x)).map(Number).filter((n) => n <= 60))]
    .sort((a, b) => b - a).slice(0, 6);

/* ───────── Форматирование ───────── */
const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export const PER = { month: 'мес', year: 'год', week: 'нед' };
export const fmt = (n) => Number(n).toFixed(2).replace(/\.?0+$/, '');
export const fmtDate = (s) => `${+s.slice(8)} ${MON[+s.slice(5, 7) - 1]}`;
const pl = (n, a, b, c) => { const x = n % 10, y = n % 100; return y > 10 && y < 20 ? c : x === 1 ? a : x >= 2 && x <= 4 ? b : c; };
export const inDays = (n) => (n === 0 ? 'сегодня' : n === 1 ? 'завтра' : `через ${n} ${pl(n, 'день', 'дня', 'дней')}`);

export function reminderLine(s, left) {
  const when = left === 0 ? 'сегодня' : `${inDays(left)} (${fmtDate(s.next_date)})`;
  const price = `${fmt(s.amount)} ${s.currency}`;
  return Number(s.trial)
    ? `🎁 <b>${esc(s.name)}</b> — пробный период заканчивается ${when}, дальше ${price}/${PER[s.period]}`
    : `🔔 <b>${esc(s.name)}</b> — списание ${price} ${when}`;
}
