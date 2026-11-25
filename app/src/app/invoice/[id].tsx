import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Card, Chips, ErrorBox, Field, Loading, Muted, Pill, Row, Screen, Section, Toggle } from '../../components/ui';
import { addPayment, deleteInvoice, deletePayment, getInvoice, getJob, getJobFinance, invoiceBalance, invoicePill, setInvoiceItems, updateInvoice } from '../../lib/api';
import { date, money, parseNumber, parseUserDate, todayIso, toUserDate } from '../../lib/format';
import { useQuery } from '../../lib/useQuery';
import { colors } from '../../theme';
import { notify } from '../../lib/notify';

export default function InvoiceDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, loading, reload } = useQuery(() => getInvoice(id), [id]);
  const [amount, setAmount] = useState('');
  const [on, setOn] = useState(toUserDate(todayIso()));
  const [ref, setRef] = useState('');
  const [editing, setEditing] = useState(false);
  const [delPay, setDelPay] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) return <Screen><ErrorBox message={error} /></Screen>;
  if (!data) return <Loading />;
  const { invoice: inv, payments, items } = data;
  const balance = invoiceBalance(inv);

  async function pay() {
    const a = parseNumber(amount);
    const d = parseUserDate(on);
    if (!a || a <= 0) return notify('Enter the amount received');
    if (!d) return notify('Check the date', 'Use the format 31.12.2026');
    setBusy(true);
    try {
      await addPayment(inv.id, a, d, ref);
      setAmount(''); setRef('');
      await reload();
    } catch (e: any) { notify('Could not save', e.message); } finally { setBusy(false); }
  }


  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Stack.Screen options={{ title: `Invoice ${inv.invoice_no}` }} />
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{inv.customer_code}  ·  {inv.job_no}</Text>
          <Pill {...invoicePill(inv)} />
        </View>
        <Row label="Invoice date" value={date(inv.invoice_date)} />
        <Row label="Amount (incl. GST)" value={inv.amount == null ? 'Not entered' : money(inv.amount)} />
        <Row label="Received" value={money(inv.paid_amount)} />
        {inv.is_credit_note && inv.against_invoice_id ? <Text style={{ color: colors.info, fontWeight: '600' }} onPress={() => router.push(`/invoice/${inv.against_invoice_id}`)}>Open the invoice this credit note is against</Text> : null}
        {inv.credited_amount > 0 ? <Row label="Credit notes against it" value={money(inv.credited_amount)} /> : null}
        <Row label="Balance" value={inv.amount == null ? '–' : money(balance)} />
        {inv.amount == null ? <Muted>The amount isn't known yet (an item may be split over more than one invoice). Tap Edit invoice to enter it.</Muted> : null}
        {(inv as any).edited_at ? <Muted>Edited{(inv as any).edited_by_name ? ` by ${(inv as any).edited_by_name}` : ''} on {date(String((inv as any).edited_at).slice(0, 10))}</Muted> : null}
        {editing
          ? <EditInvoice inv={inv} linked={items.map((it) => it.line_items.id)} hasPayments={payments.length > 0}
              onDone={(deleted) => { setEditing(false); if (deleted) router.back(); else reload(); }} />
          : <Text style={{ color: colors.info, fontWeight: '600' }} onPress={() => setEditing(true)}>Edit invoice</Text>}
      </Card>

      <Section title="Items on this invoice">
        {items.length === 0 ? <Muted>No items linked.</Muted> : items.map((it) => (
          <Card key={it.line_items.id}>
            <Text style={{ color: colors.text }}>{it.line_items.description}</Text>
            <Muted>Qty {it.qty ?? it.line_items.qty}  ·  {money(it.line_items.line_item_prices?.total_value)}</Muted>
          </Card>
        ))}
      </Section>

      <Section title="Payments">
        {payments.length === 0 ? <Muted>No payments recorded.</Muted> : payments.map((p) => (
          <Card key={p.id}>
            <Row label={date(p.paid_on)} value={money(p.amount)} />
            {p.reference ? <Muted>Ref {p.reference}</Muted> : null}
            <Text style={{ color: colors.bad, fontWeight: '600' }} onPress={async () => {
              if (delPay !== p.id) return setDelPay(p.id);
              try { await deletePayment(p.id); setDelPay(null); reload(); } catch (e: any) { notify('Could not delete', e.message); }
            }}>{delPay === p.id ? 'Tap again to delete this payment' : 'Delete payment'}</Text>
          </Card>
        ))}
        <Card>
          <Field label="Amount received (₹)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder={balance > 0 ? String(Math.round(balance)) : ''} />
          <Field label="Date" value={on} onChangeText={setOn} placeholder="31.12.2026" />
          <Field label="UTR / cheque no." value={ref} onChangeText={setRef} />
          <Button title="Record payment" onPress={pay} busy={busy} icon="cash-outline" />
        </Card>
      </Section>
    </Screen>
  );
}

function EditInvoice({ inv, linked, hasPayments, onDone }: {
  inv: { id: string; job_id: string; invoice_no: string; invoice_date: string | null; amount: number | null; is_credit_note?: boolean; against_invoice_id?: string | null };
  linked: string[]; hasPayments: boolean; onDone: (deleted?: boolean) => void;
}) {
  const { data: job } = useQuery(() => getJob(inv.job_id), [inv.job_id]);
  const { data: fin } = useQuery(() => inv.is_credit_note ? getJobFinance(inv.job_id, []) : Promise.resolve(null), [inv.job_id, inv.is_credit_note]);
  const billed = (fin?.invoices ?? []).filter((i) => !i.is_credit_note && (i.amount ?? 0) >= 0);
  const [against, setAgainst] = useState<string>(inv.against_invoice_id ?? '');
  const [no, setNo] = useState(inv.invoice_no);
  const [on, setOn] = useState(toUserDate(inv.invoice_date));
  const [amt, setAmt] = useState(inv.amount?.toString() ?? '');
  const [picked, setPicked] = useState<Record<string, boolean>>(Object.fromEntries(linked.map((id) => [id, true])));
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    const d = on.trim() ? parseUserDate(on) : null;
    if (on.trim() && !d) return notify('Check the date', 'Use the format 31.12.2026');
    if (!no.trim()) return notify('Enter the invoice number');
    const a = amt.trim() ? parseNumber(amt) : null;
    if (amt.trim() && a == null) return notify('Check the amount');
    setBusy(true);
    try {
      await updateInvoice(inv.id, { invoice_no: no.trim(), invoice_date: d, amount: inv.is_credit_note && a != null ? -Math.abs(a) : a, ...(inv.is_credit_note ? { against_invoice_id: against || null } : {}) });
      const ids = Object.keys(picked).filter((k) => picked[k]);
      if (ids.sort().join() !== [...linked].sort().join()) await setInvoiceItems(inv.id, ids);
      onDone();
    } catch (e: any) { notify('Could not save', e.message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!confirmDel) return setConfirmDel(true);
    setBusy(true);
    try { await deleteInvoice(inv.id); onDone(true); } catch (e: any) { notify('Could not delete', e.message); } finally { setBusy(false); }
  }
  return (
    <View style={{ gap: 6, marginTop: 6 }}>
      <Field label="Invoice no." value={no} onChangeText={setNo} autoCapitalize="characters" />
      <Field label="Invoice date" value={on} onChangeText={setOn} placeholder="31.12.2026" />
      <Field label="Amount incl. GST (₹)" value={amt} onChangeText={setAmt} keyboardType="decimal-pad" />
      {inv.is_credit_note && billed.length > 0 && <>
        <Muted>Against invoice</Muted>
        <Chips options={billed.map((i) => ({ value: i.id, label: i.invoice_no }))} value={against} onChange={setAgainst} />
      </>}
      <Muted>Items on this invoice</Muted>
      {!job ? <Muted>Loading items…</Muted> : job.items.map((it) => (
        <Toggle key={it.id} label={`${it.line_no}. ${it.description.slice(0, 60)}`} value={!!picked[it.id]} onChange={(v) => setPicked({ ...picked, [it.id]: v })} />
      ))}
      <Button title="Save changes" onPress={save} busy={busy} />
      {hasPayments
        ? <Muted>To delete this invoice, delete its payments first.</Muted>
        : <Button title={confirmDel ? 'Tap again to delete this invoice' : 'Delete invoice'} kind="secondary" onPress={remove} busy={busy} />}
      <Button title="Cancel" kind="secondary" onPress={() => onDone()} />
    </View>
  );
}
