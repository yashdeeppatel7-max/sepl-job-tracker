// Turns the JSON from daily.sql / weekly.sql into an email and sends it through Gmail.
//
//   node summaries/send.mjs daily  data.json recipients.json
//   node summaries/send.mjs weekly data.json recipients.json
//
// recipients.json comes from recipients.sql: the login emails of the active Director(s) and CEO(s).
//
// Environment:
//   GMAIL_USER, GMAIL_APP_PASSWORD  the Gmail address that sends, and its 16-letter app password
//   MAIL_TO_DIRECTOR, MAIL_TO_CEO   optional: other addresses to use instead (comma-separated)
//   ONLY_DIRECTOR=true              send only to the Director (used for test runs)
//   DRY_RUN=true                    write the email to summary-preview.html instead of sending (local testing)
//
// The repository is public, so nothing about the data or the addresses is ever printed
// in the GitHub log. Only counts and success/failure are logged.
import { readFileSync, writeFileSync } from 'node:fs';

const APP_URL = 'https://yashdeeppatel7-max.github.io/sepl-job-tracker/';
const MAX_LIST = 15;     // lines per section before "+N more"
const ORANGE = '#E8731A', BLUE = '#1F4E8C';

const [kind, file, rcptFile] = process.argv.slice(2);
if (!['daily', 'weekly'].includes(kind) || !file) {
  console.error('usage: send.mjs daily|weekly data.json [recipients.json]');
  process.exit(2);
}
const data = JSON.parse(readFileSync(file, 'utf8'));

// ---------- helpers ----------
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const crore = (n) => { n = Number(n) || 0; return n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)} L` : inr(n); };
const short = (s, n = 40) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const day = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const po = (r) => `${r.job}${r.cust ? ' ' + r.cust : ''}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A report is a list of blocks: { p: 'text' } or { title, rows: [...], more, note }
function section(blocks, title, rows, fmt, color) {
  if (!rows.length) return;
  blocks.push({ title, color, rows: rows.slice(0, MAX_LIST).map(fmt), more: Math.max(0, rows.length - MAX_LIST) });
}

// "Pump shaft, Impeller → Final lathe machining (Ramesh)": items sharing a stage go on one line
function movedText(items) {
  const groups = new Map();
  for (const it of items) {
    const key = `${it.stage}|${it.status}|${it.by}`;
    if (!groups.has(key)) groups.set(key, { ...it, names: [] });
    groups.get(key).names.push(short(it.item, 30));
  }
  return [...groups.values()].map((g) => {
    const names = g.names.length > 4 ? `${g.names.length} items` : g.names.join(', ');
    const st = g.status === 'in_progress' ? ' (started)' : g.status === 'skipped' ? ' (skipped)' : '';
    return `${names} → ${g.stage}${st}${g.by ? ` (${g.by})` : ''}`;
  }).join('; ');
}

// ---------- daily ----------
function daily(d) {
  const sinceText = Date.parse(d.today) - Date.parse(d.since) > 86400000 ? `since ${day(d.since)}` : `yesterday (${day(d.since)})`;
  const B = [{ p: `What moved ${sinceText}, and what's stuck.` }];

  const itemCount = d.moves.reduce((n, m) => n + m.items.length, 0);
  section(B, `Work moved: ${plural(d.moves.length, 'PO')}, ${plural(itemCount, 'item')}`, d.moves,
    (m) => `<b>${esc(po(m))}</b>: ${esc(movedText(m.items))}`, BLUE);

  section(B, `Despatched: ${plural(d.despatches.length, 'PO')}`, d.despatches, (m) => {
    const part = m.items.filter((i) => i.part).length;
    const names = m.items.length > 4 ? plural(m.items.length, 'item') : m.items.map((i) => short(i.item, 30)).join(', ');
    return `<b>${esc(po(m))}</b>: ${esc(names)}${part ? ` (${part === m.items.length ? 'part' : part + ' part'})` : ''}`;
  }, BLUE);

  const invTotal = d.invoices.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  section(B, `Invoices raised: ${d.invoices.length}, ${inr(invTotal)}`, d.invoices,
    (i) => `<b>${esc(i.invoice_no)}</b> · ${esc(i.job_no)} ${esc(i.cust)} · ${i.amount == null ? 'no amount' : inr(i.amount)}${i.credit_note ? ' (credit note)' : ''}`, BLUE);

  const payTotal = d.payments.reduce((s, p) => s + Number(p.amount), 0);
  section(B, `Payments received: ${inr(payTotal)}`, d.payments,
    (p) => `<b>${esc(p.cust)}</b> ${inr(p.amount)} · ${esc(p.invoice_no)} (${esc(p.job_no)})`, BLUE);

  if (!d.moves.length && !d.despatches.length && !d.invoices.length && !d.payments.length)
    B.push({ p: 'No updates were entered in the app.' });

  // overdue: closest to on-time first, so recent slips are seen; very old ones are only counted
  const recent = d.overdue.filter((o) => o.late <= 90);
  const old = d.overdue.length - recent.length;
  section(B, `Overdue: ${plural(d.overdue.length, 'PO')} past delivery date`, recent,
    (o) => `<b>${esc(po(o))}</b>: ${plural(o.late, 'day')} late, at ${esc(o.stage)}${o.left > 1 ? ` (${o.left} items left)` : ''}`, ORANGE);
  if (old) B.push({ p: `${plural(old, 'more PO')} ${old === 1 ? 'is' : 'are'} over 90 days late (old POs to close or update in the app).` });

  section(B, `Due in the next 7 days: ${d.due_soon.length}`, d.due_soon,
    (o) => `<b>${esc(po(o))}</b>: ${o.in === 0 ? 'due today' : `in ${plural(o.in, 'day')}`}, at ${esc(o.stage)}`, ORANGE);

  section(B, `No update for 10+ days: ${plural(d.idle.length, 'PO')}`, d.idle,
    (o) => `<b>${esc(po(o))}</b>: ${o.days} days, at ${esc(o.stage)}`, ORANGE);

  const subject = `SEPL daily update, ${day(d.today)}: ${plural(d.moves.length + d.despatches.length, 'PO')} moved, ${d.overdue.length} overdue`;
  return { subject, title: `Daily update · ${day(d.today)}`, blocks: B };
}

// ---------- weekly ----------
function weekly(w) {
  const B = [];
  if (!w.count) B.push({ p: 'No unpaid customer invoices.' });
  else {
    const a = w.aging;
    B.push({ p: `Customers owe <b style="font-size:20px;color:${BLUE}">${inr(w.total)}</b> on ${plural(Number(w.count), 'invoice')}.` });
    B.push({ title: 'By age of invoice', color: BLUE, rows: [
      `0–30 days: <b>${inr(a.d0_30)}</b>`, `31–60 days: <b>${inr(a.d31_60)}</b>`,
      `61–90 days: <b>${inr(a.d61_90)}</b>`, `Over 90 days: <b>${inr(a.d90)}</b>`], more: 0 });
  }
  B.push({ p: `Received in the last 7 days: <b>${inr(w.received_7d)}</b>` });

  section(B, `Past due date: ${w.past_due_date.length}`, w.past_due_date,
    (i) => `<b>${esc(i.cust)}</b> ${inr(i.balance)} · ${esc(i.invoice_no)} · due ${day(i.due_date)}`, ORANGE);
  section(B, 'By customer', w.by_customer,
    (c) => `<b>${esc(c.cust || '(no customer)')}</b> ${inr(c.balance)} · ${plural(Number(c.n), 'invoice')}, oldest ${c.oldest} days`, BLUE);
  section(B, 'Oldest unpaid', w.oldest,
    (i) => `<b>${esc(i.invoice_no)}</b> · ${esc(i.cust)} ${inr(i.balance)}${i.part_paid ? ' (part paid)' : ''} · ${i.age} days`, ORANGE);
  if (Number(w.bills_total) > 0)
    section(B, `We owe suppliers: ${inr(w.bills_total)}`, w.bills,
      (b) => `<b>${esc(short(b.vendor, 30))}</b> ${inr(b.amount)} · bill ${esc(b.bill_no)} · ${b.age} days`, BLUE);
  const na = Number(w.no_amount);
  if (na > 0) B.push({ p: `Note: ${plural(na, 'unpaid invoice')} ${na === 1 ? 'has' : 'have'} no amount entered, so ${na === 1 ? 'it is' : 'they are'} not counted above.` });

  return { subject: `SEPL payments due, ${day(w.today)}: ${crore(w.total)} outstanding`, title: `Payments due · ${day(w.today)}`, blocks: B };
}

// ---------- render ----------
function html(r) {
  const body = r.blocks.map((b) => b.p
    ? `<p style="margin:14px 0">${b.p}</p>`
    : `<h3 style="margin:22px 0 6px;font-size:15px;color:${b.color};border-bottom:2px solid ${b.color};padding-bottom:4px">${esc(b.title)}</h3>
       <ul style="margin:0;padding-left:20px">${b.rows.map((x) => `<li style="margin:4px 0">${x}</li>`).join('')}</ul>
       ${b.more ? `<p style="margin:4px 0;color:#666">…and ${b.more} more in the app</p>` : ''}`).join('\n');
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7">
<div style="max-width:640px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#1d1d1f;background:#fff">
  <div style="background:${BLUE};color:#fff;padding:16px 20px;border-bottom:4px solid ${ORANGE}">
    <div style="font-size:18px;font-weight:bold">SEPL PO Status</div>
    <div style="font-size:14px;opacity:.9">${esc(r.title)}</div>
  </div>
  <div style="padding:4px 20px 20px">${body}
    <p style="margin:24px 0 0"><a href="${APP_URL}" style="background:${ORANGE};color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block">Open the app</a></p>
  </div>
</div></body></html>`;
}
function text(r) {
  const strip = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const L = [r.title, ''];
  for (const b of r.blocks) {
    if (b.p) { L.push(strip(b.p), ''); continue; }
    L.push(strip(b.title), ...b.rows.map((x) => '- ' + strip(x)));
    if (b.more) L.push(`  …and ${b.more} more in the app`);
    L.push('');
  }
  L.push(`Open the app: ${APP_URL}`);
  return L.join('\n');
}

const report = kind === 'daily' ? daily(data) : weekly(data);

if (process.env.DRY_RUN === 'true') {
  writeFileSync('summary-preview.html', html(report));
  console.log(report.subject + '\n\n' + text(report));
  process.exit(0);
}

// ---------- recipients ----------
const split = (s) => String(s || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
const fromDb = rcptFile ? JSON.parse(readFileSync(rcptFile, 'utf8') || '{}') : {};
const director = split(process.env.MAIL_TO_DIRECTOR).length ? split(process.env.MAIL_TO_DIRECTOR) : split((fromDb.director || []).join(','));
const ceo = split(process.env.MAIL_TO_CEO).length ? split(process.env.MAIL_TO_CEO) : split((fromDb.ceo || []).join(','));
const to = [...new Set(kind === 'weekly' || process.env.ONLY_DIRECTOR === 'true' ? director : [...director, ...ceo])];
console.log(`Recipients: ${director.length} Director, ${kind === 'weekly' || process.env.ONLY_DIRECTOR === 'true' ? 0 : ceo.length} CEO`);
if (!to.length) { console.log('::error::No email address found for the Director (set MAIL_TO_DIRECTOR or check the Users screen)'); process.exit(1); }

// ---------- send ----------
const user = (process.env.GMAIL_USER || '').trim();
// App passwords are 16 letters, often copied as "abcd efgh ijkl mnop" (with spaces or odd characters)
const rawPass = (process.env.GMAIL_APP_PASSWORD || '').trim();
const letters = rawPass.replace(/[^a-zA-Z]/g, '').toLowerCase();
const pass = letters.length === 16 ? letters : rawPass;
if (!user || !rawPass) {
  console.log('::error::Add the GMAIL_USER and GMAIL_APP_PASSWORD secrets');
  process.exit(1);
}
if (!user.includes('@')) console.log('::warning::GMAIL_USER should be the full Gmail address, e.g. name@gmail.com');
if (letters.length !== 16) console.log(`::warning::GMAIL_APP_PASSWORD has ${letters.length} letters; a Google app password has 16. Trying it anyway.`);
const nodemailer = (await import('nodemailer')).default;
const mailer = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
try {
  // one email, everyone in Bcc, so nobody's address is shown to the others
  await mailer.sendMail({ from: `"SEPL PO Status" <${user}>`, to: user, bcc: to, subject: report.subject, text: text(report), html: html(report) });
  console.log(`Sent to ${to.length} recipient(s)`);
} catch (e) {
  console.log(`::error::Gmail did not accept the email (${e.responseCode || e.code || 'error'}). Check GMAIL_USER and GMAIL_APP_PASSWORD.`);
  process.exit(1);
}
