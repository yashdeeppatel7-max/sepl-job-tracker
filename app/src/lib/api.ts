// All database reads and writes in one place. Row-level security on the
// server decides what each role gets back; finance queries simply return
// nothing for the Production manager.
import { must } from './useQuery';
import { supabase } from './supabase';

export type Stage = { code: string; seq: number; label: string; owner: 'production' | 'finance'; optional_for: 'tpi' | 'rectification' | null };
export type JobStatus = 'enquiry' | 'quoted' | 'po_received' | 'in_progress' | 'completed' | 'on_hold' | 'cancelled';

export type JobRow = {
  id: string; job_no: string; customer_po_no: string | null; po_date: string | null; delivery_date: string | null;
  status: JobStatus; tpi_required: boolean; customer_code: string | null; customer_name: string | null;
  item_count: number; items_despatched: number; slowest_stage_seq: number | null; overdue: boolean;
};

export type Job = {
  id: string; job_no: string; customer_id: string | null; customer_po_no: string | null; po_date: string | null;
  delivery_date: string | null; status: JobStatus; tpi_required: boolean; tpi_agency: string | null;
  qap_ref: string | null; remarks: string | null; customers: { code: string; name: string | null } | null;
};

export type LineItem = {
  id: string; job_id: string; line_no: number; description: string; item_code: string | null; qty: number;
  unit: string; needs_rectification: boolean; current_stage: string | null;
  current_status: 'in_progress' | 'done' | 'skipped' | null; stage_updated_at: string | null;
};

export type Price = {
  line_item_id: string; rate: number | null; basic_value: number | null; taxable_value: number | null;
  gst_pct: number | null; gst_value: number | null; total_value: number | null; finance_notes: string | null;
};

export type StageEvent = {
  id: string; stage_code: string; status: 'in_progress' | 'done' | 'skipped'; mode: 'in_house' | 'job_work';
  note: string | null; happened_on: string; created_at: string; vendors: { name: string } | null;
  profiles: { full_name: string } | null;
};

export type InvoiceRow = {
  id: string; job_id: string; invoice_no: string; invoice_date: string | null; amount: number | null;
  due_date: string | null; notes: string | null; job_no: string; customer_code: string | null;
  paid_amount: number; payment_status: 'paid' | 'part_paid' | 'unpaid';
};

export type DespatchRow = {
  id: string; job_id: string; job_no: string; customer_code: string | null; despatched_on: string;
  transporter: string | null; vehicle_no: string | null; lr_no: string | null; documents_sent: boolean;
  notes: string | null; invoice_no: string | null;
};

let stagesCache: Stage[] | null = null;
export async function getStages(): Promise<Stage[]> {
  if (stagesCache) return stagesCache;
  stagesCache = must(await supabase.from('stages').select('*').order('seq'));
  return stagesCache!;
}
export const stageLabel = (stages: Stage[], code: string | null) =>
  code ? stages.find((s) => s.code === code)?.label ?? code : 'Not started';

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  enquiry: 'Enquiry', quoted: 'Quoted', po_received: 'PO received', in_progress: 'In progress',
  completed: 'Completed', on_hold: 'On hold', cancelled: 'Cancelled',
};

// ---------- jobs ----------
export async function listJobs(): Promise<JobRow[]> {
  const all: JobRow[] = [];
  for (let from = 0; ; from += 1000) {
    const page = must(await supabase.from('job_overview').select('*').order('job_no', { ascending: true }).range(from, from + 999));
    all.push(...(page as JobRow[]));
    if (page.length < 1000) break;
  }
  return all;
}

/** Job totals; empty for roles without money access. */
export async function listJobValues(): Promise<Record<string, number>> {
  const rows = must(await supabase.from('job_values').select('job_id, total_value')) as { job_id: string; total_value: number }[];
  return Object.fromEntries(rows.map((r) => [r.job_id, r.total_value]));
}

export async function getJob(id: string) {
  const [job, items] = await Promise.all([
    supabase.from('jobs').select('*, customers(code, name)').eq('id', id).single(),
    supabase.from('line_items').select('*').eq('job_id', id).order('line_no'),
  ]);
  return { job: must(job) as Job, items: must(items) as LineItem[] };
}

export async function getJobFinance(jobId: string, itemIds: string[]) {
  const [prices, invoices, despatches] = await Promise.all([
    itemIds.length ? supabase.from('line_item_prices').select('*').in('line_item_id', itemIds) : Promise.resolve({ data: [], error: null }),
    supabase.from('invoice_status').select('*').eq('job_id', jobId).order('invoice_date'),
    supabase.from('despatch_overview').select('*').eq('job_id', jobId).order('despatched_on'),
  ]);
  return {
    prices: Object.fromEntries((must(prices) as Price[]).map((p) => [p.line_item_id, p])) as Record<string, Price>,
    invoices: must(invoices) as InvoiceRow[],
    despatches: must(despatches) as DespatchRow[],
  };
}

export async function updateJob(id: string, patch: Partial<Pick<Job, 'status' | 'tpi_required' | 'tpi_agency' | 'qap_ref' | 'remarks' | 'delivery_date'>>) {
  must(await supabase.from('jobs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select('id'));
}

export type NewJob = {
  job_no: string; customer: string; customer_po_no: string; po_date: string | null; delivery_date: string | null;
  tpi_required: boolean; status: JobStatus;
  items: { description: string; item_code: string; qty: number; rate: number | null; gst_pct: number }[];
};

export async function createJob(j: NewJob): Promise<string> {
  const code = j.customer.trim().toUpperCase();
  let cust = must(await supabase.from('customers').select('id').eq('code', code).maybeSingle()) as { id: string } | null;
  if (!cust) cust = must(await supabase.from('customers').insert({ code }).select('id').single()) as { id: string };
  const job = must(await supabase.from('jobs').insert({
    job_no: j.job_no.trim(), customer_id: cust.id, customer_po_no: j.customer_po_no.trim() || null,
    po_date: j.po_date, delivery_date: j.delivery_date, tpi_required: j.tpi_required, status: j.status,
  }).select('id').single()) as { id: string };
  const items = must(await supabase.from('line_items').insert(j.items.map((it, i) => ({
    job_id: job.id, line_no: i + 1, description: it.description.trim(), item_code: it.item_code.trim() || null, qty: it.qty,
  }))).select('id, line_no')) as { id: string; line_no: number }[];
  const prices = items.map((li) => {
    const it = j.items[li.line_no - 1];
    if (it.rate == null) return null;
    const basic = it.rate * it.qty;
    const gst = Math.round(basic * it.gst_pct) / 100;
    return { line_item_id: li.id, rate: it.rate, basic_value: basic, taxable_value: basic, gst_pct: it.gst_pct, gst_value: gst, total_value: basic + gst };
  }).filter((p): p is NonNullable<typeof p> => p != null);
  if (prices.length) must(await supabase.from('line_item_prices').insert(prices).select('line_item_id'));
  return job.id;
}

// ---------- items & stages ----------
export async function getItem(id: string) {
  const item = must(await supabase.from('line_items').select('*, jobs(id, job_no, tpi_required, customers(code))').eq('id', id).single()) as
    LineItem & { jobs: { id: string; job_no: string; tpi_required: boolean; customers: { code: string } | null } };
  const events = must(await supabase.from('stage_events')
    .select('id, stage_code, status, mode, note, happened_on, created_at, vendors(name), profiles:created_by(full_name)')
    .eq('line_item_id', id).order('created_at', { ascending: false })) as unknown as StageEvent[];
  return { item, events };
}

export async function addStageEvent(e: {
  line_item_id: string; stage_code: string; status: string; mode: string; vendor_name?: string; note?: string; happened_on: string;
}) {
  const { data: { user } } = await supabase.auth.getUser();
  let vendor_id: string | null = null;
  const vn = e.vendor_name?.trim();
  if (e.mode === 'job_work' && vn) {
    const found = must(await supabase.from('vendors').select('id').ilike('name', vn).maybeSingle()) as { id: string } | null;
    vendor_id = found?.id ?? (must(await supabase.from('vendors').insert({ name: vn, kind: 'job_work' }).select('id').single()) as { id: string }).id;
  }
  must(await supabase.from('stage_events').insert({
    line_item_id: e.line_item_id, stage_code: e.stage_code, status: e.status, mode: e.mode, vendor_id,
    note: e.note?.trim() || null, happened_on: e.happened_on, created_by: user?.id,
  }).select('id'));
}

export async function setNeedsRectification(itemId: string, value: boolean) {
  must(await supabase.from('line_items').update({ needs_rectification: value }).eq('id', itemId).select('id'));
}

export async function listVendors(): Promise<{ id: string; name: string }[]> {
  return must(await supabase.from('vendors').select('id, name').order('name')) as { id: string; name: string }[];
}

// ---------- finance ----------
export async function listInvoices(): Promise<InvoiceRow[]> {
  return must(await supabase.from('invoice_status').select('*').order('invoice_date', { ascending: false, nullsFirst: false }).limit(1000)) as InvoiceRow[];
}

export async function getInvoice(id: string) {
  const [inv, pays, items] = await Promise.all([
    supabase.from('invoice_status').select('*').eq('id', id).single(),
    supabase.from('payments').select('*').eq('invoice_id', id).order('paid_on'),
    supabase.from('invoice_items').select('qty, line_items(id, description, qty, line_item_prices(total_value))').eq('invoice_id', id),
  ]);
  return {
    invoice: must(inv) as InvoiceRow,
    payments: must(pays) as { id: string; paid_on: string; amount: number; reference: string | null }[],
    items: must(items) as unknown as { qty: number | null; line_items: { id: string; description: string; qty: number; line_item_prices: { total_value: number | null } | null } }[],
  };
}

export async function updateInvoice(id: string, patch: { amount?: number | null; due_date?: string | null; notes?: string | null }) {
  must(await supabase.from('invoices').update(patch).eq('id', id).select('id'));
}

export async function addPayment(invoice_id: string, amount: number, paid_on: string, reference: string) {
  must(await supabase.from('payments').insert({ invoice_id, amount, paid_on, reference: reference.trim() || null }).select('id'));
}

/** Creates an invoice for some items of a job and marks them "Invoice prepared". */
export async function createInvoice(job_id: string, invoice_no: string, invoice_date: string, itemIds: string[], amount: number | null) {
  const inv = must(await supabase.from('invoices').insert({ job_id, invoice_no: invoice_no.trim(), invoice_date, amount }).select('id').single()) as { id: string };
  if (itemIds.length) {
    must(await supabase.from('invoice_items').insert(itemIds.map((line_item_id) => ({ invoice_id: inv.id, line_item_id }))).select('invoice_id'));
    for (const id of itemIds) await addStageEvent({ line_item_id: id, stage_code: 'invoiced', status: 'done', mode: 'in_house', happened_on: invoice_date, note: `Invoice ${invoice_no}` });
  }
  return inv.id;
}

export type VendorBill = { id: string; bill_no: string; bill_date: string | null; amount: number; paid: boolean; paid_on: string | null; notes: string | null; vendors: { name: string } | null; jobs: { job_no: string } | null };

export async function listBills(): Promise<VendorBill[]> {
  return must(await supabase.from('vendor_bills').select('*, vendors(name), jobs(job_no)').order('bill_date', { ascending: false, nullsFirst: false }).limit(500)) as VendorBill[];
}

export async function createBill(b: { vendor: string; job_no: string; bill_no: string; bill_date: string | null; amount: number; notes: string }) {
  const vn = b.vendor.trim();
  const found = must(await supabase.from('vendors').select('id').ilike('name', vn).maybeSingle()) as { id: string } | null;
  const vendor_id = found?.id ?? (must(await supabase.from('vendors').insert({ name: vn, kind: 'raw_material' }).select('id').single()) as { id: string }).id;
  let job_id: string | null = null;
  if (b.job_no.trim()) {
    const j = must(await supabase.from('jobs').select('id').eq('job_no', b.job_no.trim()).maybeSingle()) as { id: string } | null;
    if (!j) throw new Error(`Job ${b.job_no} not found`);
    job_id = j.id;
  }
  must(await supabase.from('vendor_bills').insert({ vendor_id, job_id, bill_no: b.bill_no.trim(), bill_date: b.bill_date, amount: b.amount, notes: b.notes.trim() || null }).select('id'));
}

export async function markBillPaid(id: string, paid: boolean) {
  must(await supabase.from('vendor_bills').update({ paid, paid_on: paid ? new Date().toISOString().slice(0, 10) : null }).eq('id', id).select('id'));
}

// ---------- despatch ----------
export async function listDespatches(): Promise<DespatchRow[]> {
  return must(await supabase.from('despatch_overview').select('*').order('despatched_on', { ascending: false }).limit(500)) as DespatchRow[];
}

export async function createDespatch(d: {
  job_id: string; invoice_id: string | null; despatched_on: string; transporter: string; vehicle_no: string; lr_no: string;
  documents_sent: boolean; notes: string; itemIds: string[];
}) {
  const row = must(await supabase.from('despatches').insert({
    job_id: d.job_id, invoice_id: d.invoice_id, despatched_on: d.despatched_on, transporter: d.transporter.trim() || null,
    vehicle_no: d.vehicle_no.trim() || null, lr_no: d.lr_no.trim() || null, documents_sent: d.documents_sent, notes: d.notes.trim() || null,
  }).select('id').single()) as { id: string };
  if (d.itemIds.length) {
    must(await supabase.from('despatch_items').insert(d.itemIds.map((line_item_id) => ({ despatch_id: row.id, line_item_id }))).select('despatch_id'));
    for (const id of d.itemIds) {
      await addStageEvent({ line_item_id: id, stage_code: 'despatched', status: 'done', mode: 'in_house', happened_on: d.despatched_on, note: d.lr_no ? `LR ${d.lr_no}` : undefined });
      if (d.documents_sent) await addStageEvent({ line_item_id: id, stage_code: 'documents_sent', status: 'done', mode: 'in_house', happened_on: d.despatched_on });
    }
  }
}

export async function findJobByNo(job_no: string) {
  return must(await supabase.from('jobs').select('id, job_no').eq('job_no', job_no.trim()).maybeSingle()) as { id: string; job_no: string } | null;
}

// ---------- users ----------
export type ProfileRow = { id: string; full_name: string; role: string | null; active: boolean; created_at: string };
export async function listProfiles(): Promise<ProfileRow[]> {
  return must(await supabase.from('profiles').select('*').order('full_name')) as ProfileRow[];
}
export async function updateProfile(id: string, patch: { role?: string | null; active?: boolean; full_name?: string }) {
  must(await supabase.from('profiles').update(patch).eq('id', id).select('id'));
}
/** Calls the manage-users Edge Function (needs the service key, so it runs on the server). */
export async function createUser(u: { email: string; password: string; full_name: string; role: string }) {
  const { data, error } = await supabase.functions.invoke('manage-users', { body: { action: 'create', ...u } });
  if (error) {
    const ctx = (error as any).context;
    let msg = error.message;
    try { const body = await ctx?.json?.(); if (body?.error) msg = body.error; } catch {}
    throw new Error(msg);
  }
  return data;
}

// ---------- import ----------
export async function importRows(rows: unknown[]) {
  const res = await supabase.rpc('import_po_rows', { p_rows: rows });
  return must(res) as { jobs_new: number; jobs_updated: number; items_new: number; items_updated: number; invoices_new: number };
}

// ---------- Google Sheet sync ----------
export type SyncRun = { ran_at: string; ok: boolean; summary: Record<string, number> | null; error: string | null };
export async function lastSync(): Promise<SyncRun | null> {
  const { data, error } = await supabase.from('sync_log').select('ran_at, ok, summary, error').order('ran_at', { ascending: false }).limit(1);
  if (error) return null; // table not created yet
  return (data?.[0] as SyncRun) ?? null;
}
