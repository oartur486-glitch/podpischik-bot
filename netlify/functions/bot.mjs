// Webhook бота «Подписчик». Адрес: /.netlify/functions/bot
import {
  tg, send, esc, q, SCHEMA, validTz, localNow, diffDays, roll, parseQuick,
  parseOffsets, fmt, fmtDate, inDays, PER,
} from '../lib/core.mjs';

const HELP = `Привет! Я <b>Подписчик</b> — слежу за вашими подписками и напоминаю о списаниях.

<b>Как добавить:</b> напишите одним сообщением, например
<code>Netflix 9.99 USD 15 месяц</code>
Название, сумма, валюта, число или дата списания, период (месяц / год / неделя). Чего не хватает — я спрошу.
Пробный период: добавьте слово <b>триал</b>, а в дате укажите, когда он заканчивается.

/add — добавить подписку
/list — все подписки и сколько они стоят
/settings — часовой пояс, время и дни напоминаний`;

const USAGE = {
  tz: 'Укажите часовой пояс, например: <code>/tz Europe/Stockholm</code>',
  time: 'Укажите час напоминаний от 0 до 23, например: <code>/time 9</code>',
  days: 'Перечислите, за сколько дней напоминать (0 — в день списания), например: <code>/days 3,1,0</code>',
  cur: 'Укажите валюту по умолчанию, например: <code>/cur SEK</code>',
};

const PROMPT = {
  name: () => 'Как называется подписка? Например: Netflix',
  amount: (d, u) => `Сколько стоит «${esc(d.name)}»? Например: <code>9.99 USD</code> или <code>199 kr</code>. Если просто число — валюта ${esc(u.currency)}.`,
  date: (d) => d.trial
    ? 'Когда закончится пробный период (и начнётся списание)? Число месяца (<code>15</code>) или дата (<code>15.10</code>, <code>15.10.2026</code>).'
    : 'Когда следующее списание? Число месяца (<code>15</code>) или дата (<code>15.10</code>, <code>15.10.2026</code>, «завтра»). Если сейчас пробный период — дата его окончания.',
  period: (d) => (d.trial ? 'После пробного периода подписка продлевается:' : 'Как часто списывают?'),
};

const cancelRow = [{ text: '✖️ Отмена', callback_data: 'x' }];
const periodKb = (d) => {
  const rows = d.trial
    ? [[['Месяц', 'tp:month'], ['Год', 'tp:year'], ['Неделя', 'tp:week']]]
    : [[['Месяц', 'p:month'], ['Год', 'p:year'], ['Неделя', 'p:week']],
       [['🎁 Триал → месяц', 'tp:month'], ['🎁 Триал → год', 'tp:year']]];
  return [...rows.map((r) => r.map(([text, callback_data]) => ({ text, callback_data }))), cancelRow];
};

const setState = (chat, st) =>
  q('update users set state=$2 where chat_id=$1::bigint', [chat, st ? JSON.stringify(st) : null]);

/* ───────── Вход ───────── */
export default async (req) => {
  const url = new URL(req.url);
  const secret = process.env.WEBHOOK_SECRET || '';

  if (req.method === 'GET') {
    if (secret && url.searchParams.get('setup') === secret) {
      return new Response(await setup(url.origin), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return new Response('Подписчик работает ✅', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  if (req.method !== 'POST') return new Response('', { status: 405 });
  if (!secret || req.headers.get('x-telegram-bot-api-secret-token') !== secret) return new Response('forbidden', { status: 403 });

  let update;
  try { update = await req.json(); } catch { return new Response('bad request', { status: 400 }); }
  try { await handle(update); } catch (e) { console.error('handle:', e.message); }
  return new Response('ok'); // всегда 200, чтобы Telegram не слал одно и то же повторно
};

async function setup(origin) {
  const out = [];
  const missing = ['BOT_TOKEN', 'DATABASE_URL', 'WEBHOOK_SECRET'].filter((k) => !process.env[k]);
  if (missing.length) return `❌ Не заданы переменные: ${missing.join(', ')}`;
  try {
    for (const s of SCHEMA) await q(s);
    out.push('✅ База: таблицы готовы');
  } catch (e) { return `❌ База не отвечает: ${e.message}\nПроверьте DATABASE_URL.`; }
  const me = await tg('getMe');
  if (!me.ok) return [...out, '❌ Telegram не принял токен. Проверьте BOT_TOKEN.'].join('\n');
  out.push(`🤖 Бот: @${me.result.username}`);
  const hook = `${origin}/.netlify/functions/bot`;
  const r = await tg('setWebhook', { url: hook, secret_token: process.env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
  out.push(r.ok ? `✅ Webhook установлен: ${hook}` : `❌ Webhook: ${r.description}`);
  await tg('setMyCommands', { commands: [
    { command: 'add', description: 'Добавить подписку' },
    { command: 'list', description: 'Мои подписки' },
    { command: 'settings', description: 'Настройки' },
    { command: 'help', description: 'Помощь' },
  ] });
  out.push('Готово. Откройте бота в Telegram и отправьте /start');
  return out.join('\n');
}

/* ───────── Обработка обновлений ───────── */
async function handle(update) {
  const cb = update.callback_query, msg = update.message;
  const chat = cb ? cb.message?.chat?.id : msg?.chat?.id;
  if (!chat || (msg && msg.chat.type !== 'private')) return;
  // Создаём пользователя и заодно отсекаем повторную доставку того же обновления
  const [u] = await q(
    `insert into users(chat_id, last_update) values($1::bigint, $2::bigint)
     on conflict(chat_id) do update set last_update=$2::bigint where users.last_update < $2::bigint
     returning chat_id::text as chat_id, tz, notify_hour, offsets, currency, state`,
    [chat, update.update_id]);
  if (!u) return;
  u.st = u.state ? JSON.parse(u.state) : null;
  if (cb) return onCallback(u, cb);
  if (msg?.text) return onText(u, msg.text.trim());
}

async function onText(u, text) {
  const id = u.chat_id;
  const c = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (c) return onCommand(u, c[1].toLowerCase(), (c[2] || '').trim());
  const { today } = localNow(u.tz);
  if (u.st) return dialog(u, text, today);
  const p = parseQuick(text, today);
  if (p.amount != null && p.name) return proceed(u, p);
  return send(id, 'Не понял 🤔 Чтобы добавить подписку, напишите, например:\n<code>Netflix 9.99 USD 15 месяц</code>\n\nВсе команды: /help');
}

async function onCommand(u, cmd, args) {
  const id = u.chat_id;
  if (u.st) { await setState(id, null); u.st = null; }
  switch (cmd) {
    case 'start': case 'help': return send(id, HELP);
    case 'add': return proceed(u, args ? parseQuick(args, localNow(u.tz).today) : {});
    case 'list': return showList(u);
    case 'cancel': return send(id, 'Ок, отменил.');
    case 'settings': return showSettings(u);
    case 'tz': case 'time': case 'days': case 'cur': return setSetting(u, cmd, args);
    default: return send(id, 'Не знаю такой команды. Список: /help');
  }
}

/* ───────── Диалог добавления ───────── */
const need = (d) => ['name', 'amount', 'date', 'period'].find((k) => d[k] == null) || null;

function mergeText(d, step, text, today) {
  const p = parseQuick(text, today, step === 'name' ? 'full' : step === 'amount' ? 'amount' : 'tail');
  if (step === 'name' && p.name) d.name = p.name.slice(0, 60);
  for (const k of ['amount', 'currency', 'date', 'period', 'trial']) if (p[k] != null) d[k] = p[k];
}

async function dialog(u, text, today) {
  const { step, d } = u.st;
  mergeText(d, step, text, today);
  return proceed(u, d, need(d) === step ? '🤔 Не понял, попробуйте ещё раз.\n\n' : '');
}

async function proceed(u, d, note = '') {
  const k = need(d);
  if (!k) return finish(u, d);
  await setState(u.chat_id, { step: k, d });
  const kb = k === 'period' ? periodKb(d) : [cancelRow];
  return send(u.chat_id, note + PROMPT[k](d, u), { reply_markup: { inline_keyboard: kb } });
}

async function finish(u, d) {
  const { today } = localNow(u.tz);
  const cur = d.currency || u.currency;
  const anchor = +d.date.slice(8, 10);
  const date = roll(d.date, d.period, anchor, today);
  await q(
    `insert into subs(chat_id, name, amount, currency, next_date, anchor_day, period, trial)
     values($1::bigint, $2, $3::numeric, $4, $5::date, $6::int, $7, $8::int)`,
    [u.chat_id, d.name, d.amount, cur, date, anchor, d.period, d.trial ? 1 : 0]);
  await setState(u.chat_id, null);
  const offs = parseOffsets(u.offsets).map((n) => (n === 0 ? 'в день списания' : `за ${n} дн.`)).join(', ');
  return send(u.chat_id,
    `✅ Добавил: <b>${esc(d.name)}</b> — ${fmt(d.amount)} ${esc(cur)}/${PER[d.period]}\n` +
    `${d.trial ? '🎁 Пробный период до' : 'Ближайшее списание:'} ${fmtDate(date)} (${inDays(diffDays(today, date))}).\n` +
    `Напомню: ${offs}, в ${u.notify_hour}:00 (${esc(u.tz)}).\n\n/list — все подписки`);
}

/* ───────── Кнопки ───────── */
async function onCallback(u, cb) {
  const chat = u.chat_id, mid = cb.message.message_id, data = cb.data || '';
  await tg('answerCallbackQuery', { callback_query_id: cb.id });
  const edit = (text, kb = []) => tg('editMessageText', { chat_id: chat, message_id: mid, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
  let m;

  if (data === 'x') { await setState(chat, null); return edit('Отменено.'); }

  if ((m = data.match(/^(tp|p):(month|year|week)$/))) {
    if (!u.st) return edit('Это сообщение устарело. Начните заново: /add');
    const d = u.st.d;
    d.period = m[2];
    if (m[1] === 'tp') d.trial = 1; else if (d.trial == null) d.trial = 0;
    await tg('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: [] } });
    return proceed(u, d);
  }

  if ((m = data.match(/^del:(\d+)$/))) {
    const [s] = await q('select name from subs where id=$1::int and chat_id=$2::bigint', [m[1], chat]);
    if (!s) return;
    return send(chat, `Удалить подписку <b>${esc(s.name)}</b>?`, { reply_markup: { inline_keyboard: [[
      { text: 'Да, удалить', callback_data: `dy:${m[1]}` }, { text: 'Нет', callback_data: 'dn' }]] } });
  }
  if ((m = data.match(/^dy:(\d+)$/))) {
    const [s] = await q('delete from subs where id=$1::int and chat_id=$2::bigint returning name', [m[1], chat]);
    return edit(s ? `🗑 Удалено: <b>${esc(s.name)}</b>` : 'Уже удалено.');
  }
  if (data === 'dn') return edit('Оставляю как есть.');
}

/* ───────── Список и настройки ───────── */
async function showList(u) {
  const rows = await q(
    `select id, name, amount::text as amount, currency, next_date::text as next_date, anchor_day, period, trial
     from subs where chat_id=$1::bigint order by next_date, id`, [u.chat_id]);
  if (!rows.length) return send(u.chat_id, 'Пока пусто. Добавьте первую подписку, например:\n<code>Netflix 9.99 USD 15 месяц</code>');
  const { today } = localNow(u.tz);
  for (const r of rows) { // показываем актуальную дату, даже если ночной пересчёт ещё не случился
    const n = roll(r.next_date, r.period, +r.anchor_day, today);
    if (n !== r.next_date) { r.next_date = n; r.trial = 0; }
  }
  rows.sort((a, b) => a.next_date.localeCompare(b.next_date));
  const month = {};
  const lines = rows.map((r, i) => {
    const a = Number(r.amount);
    if (!Number(r.trial)) month[r.currency] = (month[r.currency] || 0) + (r.period === 'month' ? a : r.period === 'year' ? a / 12 : (a * 52) / 12);
    return `${i + 1}. ${Number(r.trial) ? '🎁 ' : ''}<b>${esc(r.name)}</b> — ${fmt(a)} ${esc(r.currency)}/${PER[r.period]}\n    ↳ ${fmtDate(r.next_date)} · ${inDays(diffDays(today, r.next_date))}${Number(r.trial) ? ' (конец триала)' : ''}`;
  });
  const sum = (k) => Object.entries(month).map(([c, v]) => `${fmt(v * k)} ${esc(c)}`).join(' + ') || '0';
  const kb = [];
  rows.slice(0, 40).forEach((r, i) => {
    const b = { text: `🗑 ${r.name.slice(0, 22)}`, callback_data: `del:${r.id}` };
    if (i % 2 === 0) kb.push([b]); else kb[kb.length - 1].push(b);
  });
  return send(u.chat_id,
    `📋 <b>Подписки (${rows.length})</b>\n\n${lines.join('\n')}\n\n💰 В месяц ≈ ${sum(1)}\n📆 В год ≈ ${sum(12)}\n<i>Триалы в сумму не входят.</i>`,
    { reply_markup: { inline_keyboard: kb } });
}

function showSettings(u) {
  return send(u.chat_id,
    `⚙️ <b>Настройки</b>\n\n` +
    `Часовой пояс: <b>${esc(u.tz)}</b>\n<code>/tz Europe/Stockholm</code>\n\n` +
    `Время напоминаний: <b>${u.notify_hour}:00</b>\n<code>/time 9</code>\n\n` +
    `Напоминать за (дней): <b>${parseOffsets(u.offsets).join(', ')}</b> (0 — в день списания)\n<code>/days 3,1,0</code>\n\n` +
    `Валюта по умолчанию: <b>${esc(u.currency)}</b>\n<code>/cur EUR</code>`);
}

async function setSetting(u, cmd, v) {
  let col, val, tz;
  if (cmd === 'tz' && (tz = validTz(v))) [col, val] = ['tz', tz];
  else if (cmd === 'time' && /^\d{1,2}$/.test(v) && +v < 24) [col, val] = ['notify_hour', +v];
  else if (cmd === 'days' && parseOffsets(v).length) [col, val] = ['offsets', parseOffsets(v).join(',')];
  else if (cmd === 'cur' && /^[a-zA-Z]{3}$/.test(v)) [col, val] = ['currency', v.toUpperCase()];
  if (!col) return send(u.chat_id, USAGE[cmd]);
  await q(`update users set ${col}=$2 where chat_id=$1::bigint`, [u.chat_id, val]); // col — из фиксированного списка выше
  u[col] = val;
  await send(u.chat_id, '✅ Сохранил.');
  return showSettings(u);
}
