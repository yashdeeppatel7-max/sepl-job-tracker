import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Text } from 'react-native';
import { Button, Card, Chips, Field, Muted, Screen, Section, Toggle } from '../../components/ui';
import { createDespatch, findJobByNo, getJob, getJobFinance, type InvoiceRow, type LineItem } from '../../lib/api';
import { parseUserDate, todayIso, toUserDate } from '../../lib/format';

export default function NewDespatch() {
  const params = useLocalSearchParams<{ job?: string }>();
  const [jobNo, setJobNo] = useState('');
  const [job, setJob] = useState<{ id: string; job_no: string; customer: string } | null>(null);
  const [items, setItems] = useState<LineItem[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [invoiceId, setInvoiceId] = useState<string>('none');
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [on, setOn] = useState(toUserDate(todayIso()));
  const [transporter, setTransporter] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [lr, setLr] = useState('');
  const [docs, setDocs] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  async function loadJob(id: string) {
    const { job: j, items: its } = await getJob(id);
    const fin = await getJobFinance(id, its.map((i) => i.id));
    setJob({ id: j.id, job_no: j.job_no, customer: j.customers?.code ?? '' });
    setItems(its);
    setInvoices(fin.invoices);
    setPicked(Object.fromEntries(its.filter((i) => !['despatched', 'documents_sent', 'payment_received'].includes(i.current_stage ?? '')).map((i) => [i.id, true])));
  }

  useEffect(() => { if (params.job) loadJob(params.job).catch((e) => Alert.alert('Error', e.message)); }, [params.job]);

  async function find() {
    try {
      const j = await findJobByNo(jobNo);
      if (!j) return Alert.alert('Not found', `No job ${jobNo}`);
      await loadJob(j.id);
    } catch (e: any) { Alert.alert('Error', e.message); }
  }

  async function save() {
    if (!job) return;
    const d = parseUserDate(on);
    if (!d) return Alert.alert('Check the date', 'Use the format 31.12.2026');
    setBusy(true);
    try {
      await createDespatch({
        job_id: job.id, invoice_id: invoiceId === 'none' ? null : invoiceId, despatched_on: d, transporter, vehicle_no: vehicle, lr_no: lr,
        documents_sent: docs, notes, itemIds: Object.keys(picked).filter((k) => picked[k]),
      });
      router.back();
    } catch (e: any) { Alert.alert('Could not save', e.message); } finally { setBusy(false); }
  }

  return (
    <Screen>
      {!job ? (
        <Card>
          <Field label="Job no." value={jobNo} onChangeText={setJobNo} placeholder="26-1012" autoCapitalize="none" onSubmitEditing={find} />
          <Button title="Find job" onPress={find} disabled={!jobNo.trim()} />
        </Card>
      ) : (
        <>
          <Card>
            <Text style={{ fontWeight: '700', fontSize: 16 }}>Job {job.job_no}  ·  {job.customer}</Text>
            <Field label="Despatch date" value={on} onChangeText={setOn} placeholder="31.12.2026" />
            <Field label="Transporter" value={transporter} onChangeText={setTransporter} />
            <Field label="Vehicle no." value={vehicle} onChangeText={setVehicle} autoCapitalize="characters" placeholder="GJ06AB1234" />
            <Field label="LR / docket no." value={lr} onChangeText={setLr} />
            <Toggle label="Despatch documents sent (as per PO / QAP)" value={docs} onChange={setDocs} />
            <Field label="Notes" value={notes} onChangeText={setNotes} multiline />
          </Card>
          {invoices.length > 0 && (
            <Section title="Invoice">
              <Chips value={invoiceId} onChange={setInvoiceId} options={[{ value: 'none', label: 'None' }, ...invoices.map((i) => ({ value: i.id, label: i.invoice_no }))]} />
            </Section>
          )}
          <Section title="Items despatched">
            <Card>
              {items.map((it) => (
                <Toggle key={it.id} label={`${it.line_no}. ${it.description.slice(0, 60)} (qty ${it.qty})`} value={!!picked[it.id]} onChange={(v) => setPicked({ ...picked, [it.id]: v })} />
              ))}
            </Card>
            <Muted>Selected items move to "Despatched"{docs ? ' and "Documents sent"' : ''}.</Muted>
          </Section>
          <Button title="Save despatch" onPress={save} busy={busy} icon="car-outline" />
        </>
      )}
    </Screen>
  );
}
