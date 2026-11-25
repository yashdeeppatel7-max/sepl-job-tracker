import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { Button, Card, Chips, ErrorBox, Field, Loading, Muted, Screen, Section, Toggle } from '../../components/ui';
import { createInvoice, getJob, getJobFinance, invoiceBalance } from '../../lib/api';
import { money, parseNumber, parseUserDate, todayIso, toUserDate } from '../../lib/format';
import { useQuery } from '../../lib/useQuery';
import { notify } from '../../lib/notify';

export default function NewInvoice() {
  const { job: jobId } = useLocalSearchParams<{ job: string }>();
  const { data, error } = useQuery(async () => {
    const { job, items } = await getJob(jobId);
    const fin = await getJobFinance(jobId, items.map((i) => i.id));
    return { job, items, fin };
  }, [jobId]);
  const [no, setNo] = useState('');
  const [on, setOn] = useState(toUserDate(todayIso()));
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [amount, setAmount] = useState<string | null>(null);
  const [credit, setCredit] = useState(false);
  const [against, setAgainst] = useState<string>('');
  const [busy, setBusy] = useState(false);

  if (error) return <Screen><ErrorBox message={error} /></Screen>;
  if (!data) return <Loading />;
  const ids = Object.keys(picked).filter((k) => picked[k]);
  const billed = data.fin.invoices.filter((i) => !i.is_credit_note && (i.amount ?? 0) >= 0);
  const againstInv = billed.find((i) => i.id === against);
  const suggested = credit && againstInv ? invoiceBalance(againstInv) : ids.reduce((s, id) => s + (data.fin.prices[id]?.total_value ?? 0), 0);

  async function save() {
    const d = parseUserDate(on);
    if (!no.trim()) return notify('Enter the invoice number');
    if (!d) return notify('Check the date', 'Use the format 31.12.2026');
    if (credit && billed.length && !against) return notify('Pick the invoice this credit note is against');
    const a = amount == null || amount === '' ? suggested || null : parseNumber(amount);
    setBusy(true);
    try {
      await createInvoice(jobId, no, d, ids, a, credit, credit ? against || null : null);
      router.back();
    } catch (e: any) { notify('Could not save', e.message); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <Card>
        <Text style={{ fontWeight: '700', fontSize: 16 }}>Job {data.job.job_no}  ·  {data.job.customers?.code}</Text>
        <Toggle label="This is a credit note (item rejected / returned)" value={credit} onChange={setCredit} />
        {credit && (billed.length ? <>
          <Text style={{ fontWeight: '600' }}>Against invoice</Text>
          <Chips options={billed.map((i) => ({ value: i.id, label: `${i.invoice_no}${i.amount != null ? ` · ${money(i.amount)}` : ''}` }))} value={against} onChange={setAgainst} />
        </> : <Muted>No invoices on this job yet to raise a credit note against.</Muted>)}
        <Field label={credit ? 'Credit note no.' : 'Invoice no.'} value={no} onChangeText={setNo} placeholder={credit ? 'CR-14' : '26/071'} autoCapitalize="characters" />
        <Field label="Invoice date" value={on} onChangeText={setOn} placeholder="31.12.2026" />
      </Card>
      <Section title="Items on this invoice">
        <Card>
          {data.items.map((it) => (
            <Toggle key={it.id} label={`${it.line_no}. ${it.description.slice(0, 60)} (qty ${it.qty})`} value={!!picked[it.id]} onChange={(v) => setPicked({ ...picked, [it.id]: v })} />
          ))}
        </Card>
      </Section>
      <Card>
        <Field label="Amount incl. GST (₹)" value={amount ?? ''} onChangeText={setAmount} keyboardType="decimal-pad" placeholder={suggested ? String(Math.round(suggested)) : ''} hint={suggested ? (credit && againstInv ? `Balance of ${againstInv.invoice_no}: ${money(suggested)}` : `From item values: ${money(suggested)}`) : undefined} />
        <Muted>{credit ? 'The amount is taken off what the customer owes. Enter it without a minus sign.' : 'Selected items will move to "Invoice prepared".'}</Muted>
        <Button title={credit ? 'Save credit note' : 'Create invoice'} onPress={save} busy={busy} />
      </Card>
    </Screen>
  );
}
