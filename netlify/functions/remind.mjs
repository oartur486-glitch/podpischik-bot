// Напоминания. Netlify запускает эту функцию каждый час (время UTC),
// а «9:00» у каждого пользователя считается по его часовому поясу.
import { q, send, localNow, diffDays, roll, parseOffsets, reminderLine } from '../lib/core.mjs';

export const config = { schedule: '@hourly' };

export default async () => {
  const t0 = Date.now();
  const rows = await q(
    `select u.chat_id::text as chat_id, u.tz, u.notify_hour, u.offsets,
            s.id, s.name, s.amount::text as amount, s.currency, s.next_date::text as next_date,
            s.anchor_day, s.period, s.trial, s.notified
     from users u join subs s on s.chat_id = u.chat_id
     order by u.chat_id, s.next_date`);
  const byUser = new Map();
  for (const r of rows) byUser.set(r.chat_id, [...(byUser.get(r.chat_id) || []), r]);

  for (const [chat, list] of byUser) {
    if (Date.now() - t0 > 24000) { console.log('лимит времени, остальных обработаю в следующий час'); break; }
    try { await processUser(chat, list); } catch (e) { console.error('remind', chat, e.message); }
  }
};

async function processUser(chat, list) {
  const { tz, notify_hour, offsets } = list[0];
  const { today, hour } = localNow(tz);
  const offs = parseOffsets(offsets);
  const lines = [], buttons = [], marks = [];

  for (const s of list) {
    let notified = s.notified;
    if (s.next_date < today) { // дата списания прошла — переносим на следующий период
      s.next_date = roll(s.next_date, s.period, +s.anchor_day, today);
      s.trial = 0;
      notified = '';
      await q(`update subs set next_date=$2::date, trial=0, notified='' where id=$1::int`, [s.id, s.next_date]);
    }
    if (hour < Number(notify_hour)) continue; // «>=», а не «==»: если час пропущен, напомним позже в тот же день
    const left = diffDays(today, s.next_date);
    const key = `${s.next_date}|${left}`;
    if (!offs.includes(left) || notified.split(',').includes(key)) continue;
    lines.push(reminderLine(s, left));
    buttons.push({ text: `🗑 ${s.name.slice(0, 22)}`, callback_data: `del:${s.id}` });
    marks.push([s.id, notified ? `${notified},${key}` : key]);
  }
  if (!lines.length) return;

  const kb = [];
  buttons.forEach((b, i) => (i % 2 === 0 ? kb.push([b]) : kb[kb.length - 1].push(b)));
  const r = await send(chat, `${lines.join('\n')}\n\n<i>Не нужна подписка — отмените её в сервисе до списания, а здесь уберите кнопкой ниже.</i>`,
    { reply_markup: { inline_keyboard: kb } });
  if (!r.ok) return; // не отправилось — отметку не ставим, повторим в следующий час
  for (const [id, n] of marks) await q('update subs set notified=$2 where id=$1::int', [id, n]);
}
