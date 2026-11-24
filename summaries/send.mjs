// Turns the JSON from daily.sql / weekly.sql into a WhatsApp message and sends it.
//
//   node summaries/send.mjs daily  data.json
//   node summaries/send.mjs weekly data.json
//
// Two ways to send (the first one that is set up is used):
//   1. Green API (free Developer plan, up to 3 chats): a WhatsApp number linked like WhatsApp Web.
//      GREEN_API = the three values from the green-api.com console, separated by spaces:
//                  apiUrl idInstance apiTokenInstance
//                  e.g. "https://7103.api.greenapi.com 7103123456 d75b3a66374942c5b3c019c698abc2067e151558acbd412345"
//   2. CallMeBot (free, each person activates it and gets a key).
//
// Environment:
//   WA_DIRECTOR, WA_CEO  phone number with country code, e.g. "+91 98250 12345"
//                        (for CallMeBot: the number, a space, then that person's CallMeBot key)
//   ONLY_DIRECTOR=true   send only to the Director (used for test runs)
//   DRY_RUN=true         print the message instead of sending (for local testing only)
//
// The repository is public, so nothing about the data, phone numbers or keys is ever
// printed in the GitHub log. Only counts and success/failure are logged.
import { readFileSync } from 'node:fs';

const APP_URL = 'https://yashdeeppatel7-max.github.io/sepl-job-tracker/';
const MAX_LIST = 8;      // lines per section before "+N more"

const [kind, file] = process.argv.slice(2);
if (!['daily', 'weekly'].includes(kind) || !file) {
  console.error('usage: send.mjs daily|weekly data.json');
  process.exit(2);
}
const data = JSON.parse(readFileSync(file, 'utf8'));

// ---------- formatting helpers ----------
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const short = (s, n = 34) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const day = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const po = (r) => `${r.job}${r.cust ? ' ' + r.cust : ''}`;

function section(lines, title, rows, fmt) {
  if (!rows.length) return;
  lines.push('', title);
  for (const r of rows.slice(0, MAX_LIST)) lines.push('• ' + fmt(r));
  if (rows.length > MAX_LIST) lines.push(`   …and ${rows.length - MAX_LIST} more in the app`);
}

// "Pump shaft, Impeller → Final lathe machining (Ramesh)" — items sharing a stage go on one line
function movedText(items) {
  const groups = new Map();
  for (const it of items) {
    const key = `${it.stage}|${it.status}|${it.by}`;
    if (!groups.has(key)) groups.set(key, { ...it, names: [] });
    groups.get(key).names.push(short(it.item, 26));
  }
  return [...groups.values()].map((g) => {
    const names = g.names.length > 3 ? `${g.names.length} items` : g.names.join(', ');
    const st = g.status === 'in_progress' ? ' (started)' : g.status === 'skipped' ? ' (skipped)' : '';
    return `${names} → ${g.stage}${st}${g.by ? ` (${g.by})` : ''}`;
  }).join('; ');
}

// ---------- daily ----------
function dailyMessage(d) {
  const sinceText = d.since === d.today ? '' : (Date.parse(d.today) - Date.parse(d.since) > 86400000
    ? `since ${day(d.since)}` : `yesterday, ${day(d.since)}`);
  const L = [`*SEPL daily update* – ${day(d.today)}`, `_What moved ${sinceText}, and what's stuck_`];

  const itemCount = d.moves.reduce((n, m) => n + m.items.length, 0);
  section(L, `✅ *Work moved* (${plural(d.moves.length, 'PO')}, ${plural(itemCount, 'item')})`, d.moves,
    (m) => `${po(m)}: ${movedText(m.items)}`);

  section(L, `🚚 *Despatched* (${plural(d.despatches.length, 'PO')})`, d.despatches, (m) => {
    const part = m.items.filter((i) => i.part).length;
    const names = m.items.length > 3 ? plural(m.items.length, 'item') : m.items.map((i) => short(i.item, 26)).join(', ');
    return `${po(m)}: ${names}${part ? ` (${part === m.items.length ? 'part' : part + ' part'})` : ''}`;
  });

  const invTotal = d.invoices.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  section(L, `🧾 *Invoices raised* (${d.invoices.length}, ${inr(invTotal)})`, d.invoices,
    (i) => `${i.invoice_no} · ${i.job_no} ${i.cust} · ${i.amount == null ? 'no amount' : inr(i.amount)}${i.credit_note ? ' (credit note)' : ''}`);

  const payTotal = d.payments.reduce((s, p) => s + Number(p.amount), 0);
  section(L, `💰 *Payments received* (${inr(payTotal)})`, d.payments,
    (p) => `${p.cust} ${inr(p.amount)} · ${p.invoice_no} (${p.job_no})`);

  if (!d.moves.length && !d.despatches.length && !d.invoices.length && !d.payments.length)
    L.push('', 'No updates were entered in the app.');

  // overdue: closest to on-time first, so the recent slips are seen; very old ones are counted
  const recent = d.overdue.filter((o) => o.late <= 90);
  const old = d.overdue.length - recent.length;
  section(L, `⚠️ *Overdue* (${plural(d.overdue.length, 'PO')} past delivery date)`, recent,
    (o) => `${po(o)} – ${plural(o.late, 'day')} late, at ${o.stage}${o.left > 1 ? ` (${o.left} items left)` : ''}`);
  if (old) L.push(`   ${plural(old, 'PO')} more than 90 days late (old POs to close or update)`);

  section(L, `📅 *Due in the next 7 days* (${d.due_soon.length})`, d.due_soon,
    (o) => `${po(o)} – ${o.in === 0 ? 'due today' : `in ${plural(o.in, 'day')}`}, at ${o.stage}`);

  section(L, `⏸️ *No update for 10+ days* (${plural(d.idle.length, 'PO')})`, d.idle,
    (o) => `${po(o)} – ${o.days} days, at ${o.stage}`);

  L.push('', `Open the app: ${APP_URL}`);
  return L.join('\n');
}

// ---------- weekly ----------
function weeklyMessage(w) {
  const L = [`*SEPL payments due* – ${day(w.today)}`];
  if (!w.count) {
    L.push('', 'No unpaid customer invoices. 🎉');
  } else {
    const a = w.aging;
    L.push('', `Customers owe *${inr(w.total)}* on ${plural(w.count, 'invoice')}.`,
      `By age: 0–30 days ${inr(a.d0_30)} | 31–60 ${inr(a.d31_60)} | 61–90 ${inr(a.d61_90)} | 90+ ${inr(a.d90)}`);
  }
  L.push(`Received in the last 7 days: ${inr(w.received_7d)}`);

  section(L, `⏰ *Past due date* (${w.past_due_date.length})`, w.past_due_date,
    (i) => `${i.cust} ${inr(i.balance)} · ${i.invoice_no} · due ${day(i.due_date)}`);

  section(L, '👥 *By customer*', w.by_customer,
    (c) => `${c.cust || '(no customer)'} ${inr(c.balance)} · ${plural(Number(c.n), 'invoice')}, oldest ${c.oldest} days`);

  section(L, '🕰️ *Oldest unpaid*', w.oldest,
    (i) => `${i.invoice_no} · ${i.cust} ${inr(i.balance)}${i.part_paid ? ' (part paid)' : ''} · ${i.age} days`);

  if (Number(w.bills_total) > 0) {
    section(L, `🏭 *We owe suppliers* (${inr(w.bills_total)})`, w.bills,
      (b) => `${short(b.vendor, 24)} ${inr(b.amount)} · bill ${b.bill_no} · ${b.age} days`);
  }
  if (Number(w.no_amount) > 0)
    L.push('', `Note: ${plural(Number(w.no_amount), 'unpaid invoice')} ${Number(w.no_amount) === 1 ? 'has' : 'have'} no amount entered, so ${Number(w.no_amount) === 1 ? 'it is' : 'they are'} not counted above.`);

  L.push('', `Open the app: ${APP_URL}`);
  return L.join('\n');
}

// ---------- sending ----------
const green = parseGreen(process.env.GREEN_API);
const CHUNK = green ? 4000 : 1500;      // characters per WhatsApp message

function chunks(text) {
  const out = []; let cur = '';
  for (const line of text.split('\n')) {
    if (cur && (cur + '\n' + line).length > CHUNK) { out.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out.length > 1 ? out.map((c, i) => (i ? `(${i + 1}/${out.length})\n` : '') + c) : out;
}

// "https://7103.api.greenapi.com 7103123456 d75b...": order does not matter
function parseGreen(raw) {
  if (!raw || !raw.trim()) return null;
  const parts = raw.trim().split(/[\s,;|]+/);
  let url = parts.find((x) => /^https?:\/\//i.test(x)) || 'https://api.green-api.com';
  const rest = parts.filter((x) => !/^https?:\/\//i.test(x));
  const id = rest.find((x) => /^\d{6,}$/.test(x.replace(/^waInstance/i, '')))?.replace(/^waInstance/i, '');
  const token = rest.find((x) => /^[a-z0-9]{20,}$/i.test(x) && !/^\d+$/.test(x));
  if (!id || !token) return { bad: true };
  return { url: url.replace(/\/+$/, ''), id, token };
}

// "+91 98250 12345" -> phone '919825012345'; with CallMeBot the last number is the key
function parseRecipient(raw, needKey) {
  const runs = String(raw ?? '').split(/[^0-9]+/).filter(Boolean);
  let key = null;
  if (needKey || (runs.length > 1 && runs[runs.length - 1].length < 9 && runs.join('').length > 12)) {
    if (runs.length < 2) return null;
    key = runs.pop();
  }
  let phone = runs.join('');
  if (phone.length === 10) phone = '91' + phone;      // Indian number typed without +91
  if (phone.length < 11 || phone.length > 15) return null;
  if (needKey && !key) return null;
  return { phone, key };
}

async function sendOne(rcpt, part) {
  if (green) {
    const res = await fetch(`${green.url}/waInstance${green.id}/sendMessage/${green.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: `${rcpt.phone}@c.us`, message: part }),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && !!body.idMessage, status: res.status };
  }
  const url = 'https://api.callmebot.com/whatsapp.php?' + new URLSearchParams({ phone: '+' + rcpt.phone, text: part, apikey: rcpt.key });
  const res = await fetch(url);
  const body = await res.text();
  return { ok: res.ok && !/invalid|error|not (allowed|activated)|wrong/i.test(body), status: res.status };
}

async function sendTo(label, rcpt, text) {
  for (const part of chunks(text)) {
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const r = await sendOne(rcpt, part);
        ok = r.ok;
        if (!ok) console.log(`${label}: attempt ${attempt} not accepted (HTTP ${r.status})`);
        if (r.status === 466) console.log('::error::Green API free plan limit reached (it allows 3 chats)');
        if (r.status === 401 || r.status === 403) break;
      } catch { console.log(`${label}: attempt ${attempt} network error`); }
      if (!ok) await new Promise((r) => setTimeout(r, 10000 * attempt));
    }
    if (!ok) return false;
    await new Promise((r) => setTimeout(r, 4000));       // a short gap between messages
  }
  return true;
}

const text = kind === 'daily' ? dailyMessage(data) : weeklyMessage(data);

if (process.env.DRY_RUN === 'true') {
  for (const c of chunks(text)) console.log(c + '\n-----');
  process.exit(0);
}

if (green?.bad) { console.log('::error::GREEN_API should hold apiUrl, idInstance and apiTokenInstance separated by spaces'); process.exit(1); }
console.log(`Sending with ${green ? 'Green API' : 'CallMeBot'}`);
const wanted = kind === 'weekly' || process.env.ONLY_DIRECTOR === 'true'
  ? [['Director', 'WA_DIRECTOR']] : [['Director', 'WA_DIRECTOR'], ['CEO', 'WA_CEO']];
let sent = 0, failed = 0;
for (const [label, env] of wanted) {
  if (!process.env[env]) { console.log(`::warning::${env} secret is not set, skipping the ${label}`); continue; }
  const rcpt = parseRecipient(process.env[env], !green);
  if (!rcpt) {
    console.log(`::error::${env} should be the WhatsApp number with country code${green ? '' : ', a space, then the CallMeBot key'}`);
    failed++; continue;
  }
  if (await sendTo(label, rcpt, text)) { console.log(`${label}: sent (${chunks(text).length} message(s))`); sent++; }
  else { console.log(`::error::${label}: the message was not accepted. ${green ? 'Check GREEN_API and that the WhatsApp number is still linked (green-api.com console shows "authorized").' : `Check the key in ${env}.`}`); failed++; }
}
if (failed || !sent) process.exit(1);
