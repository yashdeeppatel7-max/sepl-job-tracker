import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Card, Chips, ErrorBox, Field, Loading, Muted, Pill, Row, Screen, Section, Title, Toggle } from '../../components/ui';
import {
  getJob, getJobFinance, getStages, isCancelStage, JOB_STATUS_LABEL, stageLabel, updateJob, type JobStatus,
} from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, money, parseUserDate, toUserDate } from '../../lib/format';
import { useQuery } from '../../lib/useQuery';
import { colors } from '../../theme';
import { notify } from '../../lib/notify';

const EDITABLE_STATUS: { value: JobStatus; label: string }[] = [
  { value: 'enquiry', label: 'Enquiry' },
  { value: 'quoted', label: 'Quoted' },
  { value: 'po_received', label: 'PO received' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'completed', label: 'Completed' },
];

export default function JobDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { perms } = useAuth();
  const [editing, setEditing] = useState(false);
  const { data, error, loading, reload } = useQuery(async () => {
    const [{ job, items }, stages] = await Promise.all([getJob(id), getStages()]);
    const fin = perms.seeMoney ? await getJobFinance(id, items.map((i) => i.id)) : null;
    return { job, items, stages, fin };
  }, [id, perms.seeMoney]);

  if (error) return <Screen><ErrorBox message={error} /></Screen>;
  if (!data) return <Loading />;
  const { job, items, stages, fin } = data;
  const total = fin ? Object.values(fin.prices).reduce((s, p) => s + (p.total_value ?? 0), 0) : null;
  const taxable = fin ? Object.values(fin.prices).reduce((s, p) => s + (p.taxable_value ?? 0), 0) : null;
  const invoiced = fin ? fin.invoices.reduce((s, i) => s + (i.amount ?? 0), 0) : null;
  const received = fin ? fin.invoices.reduce((s, i) => s + i.paid_amount, 0) : null;

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Stack.Screen options={{ title: job.job_no }} />
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title>{job.customers?.code ?? '–'}</Title>
          <Pill label={JOB_STATUS_LABEL[job.status]} tone={job.status === 'completed' ? 'good' : job.status === 'cancelled' ? 'bad' : 'info'} />
        </View>
        <Row label="Customer PO" value={job.customer_po_no ?? '–'} />
        <Row label="PO date" value={date(job.po_date)} />
        <Row label="Delivery date" value={date(job.delivery_date)} />
        <Row label="Third-party inspection" value={job.tpi_required ? `Yes${job.tpi_agency ? ` (${job.tpi_agency})` : ''}` : 'No'} />
        {job.qap_ref ? <Row label="QAP" value={job.qap_ref} /> : null}
        {job.remarks ? <Muted>{job.remarks}</Muted> : null}
        {perms.manageJobs && !editing && <Button title="Edit job" kind="secondary" onPress={() => setEditing(true)} />}
      </Card>

      {editing && <EditJob job={job} onDone={() => { setEditing(false); reload(); }} />}

      {fin && (
        <Section title="Value">
          <Card>
            <Row label="Order value (before GST)" value={money(taxable)} />
            <Row label="Order value (incl. GST)" value={money(total)} />
            <Row label="Invoiced" value={money(invoiced)} />
            <Row label="Payment received" value={money(received)} />
            <Row label="Outstanding" value={<Text style={{ color: (invoiced ?? 0) - (received ?? 0) > 0 ? colors.bad : colors.text }}>{money((invoiced ?? 0) - (received ?? 0))}</Text>} />
          </Card>
        </Section>
      )}

      <Section title={`Items (${items.length})`}>
        {items.map((it) => {
          const price = fin?.prices[it.id];
          const done = ['despatched', 'documents_sent', 'payment_received'].includes(it.current_stage ?? '');
          return (
            <Card key={it.id} onPress={() => router.push(`/item/${it.id}`)}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }}>{it.line_no}. {it.description}</Text>
              <Muted>Code {it.item_code ?? '–'}  ·  Qty {it.qty} {it.unit}</Muted>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                <Pill label={`${stageLabel(stages, it.current_stage)}${it.current_status === 'in_progress' ? ' · in progress' : ''}`} tone={isCancelStage(it.current_stage) ? 'bad' : done ? 'good' : it.current_stage ? 'info' : 'neutral'} />
                {price?.total_value != null && <Text style={{ fontWeight: '600', color: colors.primary }}>{money(price.total_value)}</Text>}
              </View>
              {price?.finance_notes ? <Muted>{price.finance_notes}</Muted> : null}
            </Card>
          );
        })}
      </Section>

      {fin && (
        <Section title="Invoices" right={perms.updateFinanceStages ? <Text style={{ color: colors.info, fontWeight: '600' }} onPress={() => router.push(`/invoice/new?job=${job.id}`)}>+ New</Text> : undefined}>
          {fin.invoices.length === 0 ? <Muted>No invoices yet.</Muted> : fin.invoices.map((inv) => (
            <Card key={inv.id} onPress={() => router.push(`/invoice/${inv.id}`)}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontWeight: '600', color: colors.text }}>{inv.invoice_no}  ·  {date(inv.invoice_date)}</Text>
                <Pill label={inv.payment_status === 'paid' ? 'Paid' : inv.payment_status === 'part_paid' ? 'Part paid' : 'Unpaid'} tone={inv.payment_status === 'paid' ? 'good' : inv.payment_status === 'part_paid' ? 'warn' : 'bad'} />
              </View>
              <Muted>{money(inv.amount)}  ·  received {money(inv.paid_amount)}</Muted>
            </Card>
          ))}
        </Section>
      )}

      {fin && (
        <Section title="Despatches" right={perms.recordDespatch ? <Text style={{ color: colors.info, fontWeight: '600' }} onPress={() => router.push(`/despatch/new?job=${job.id}`)}>+ Record</Text> : undefined}>
          {fin.despatches.length === 0 ? <Muted>No despatch records yet.</Muted> : fin.despatches.map((d) => (
            <Card key={d.id}>
              <Text style={{ fontWeight: '600', color: colors.text }}>{date(d.despatched_on)}{d.invoice_no ? `  ·  Inv ${d.invoice_no}` : ''}</Text>
              <Muted>{[d.transporter, d.vehicle_no, d.lr_no && `LR ${d.lr_no}`].filter(Boolean).join('  ·  ') || 'No transport details'}</Muted>
              <Pill label={d.documents_sent ? 'Documents sent' : 'Documents pending'} tone={d.documents_sent ? 'good' : 'warn'} />
            </Card>
          ))}
        </Section>
      )}
    </Screen>
  );
}

function EditJob({ job, onDone }: { job: Awaited<ReturnType<typeof getJob>>['job']; onDone: () => void }) {
  const [status, setStatus] = useState<JobStatus>(job.status);
  const [tpi, setTpi] = useState(job.tpi_required);
  const [agency, setAgency] = useState(job.tpi_agency ?? '');
  const [qap, setQap] = useState(job.qap_ref ?? '');
  const [delivery, setDelivery] = useState(toUserDate(job.delivery_date));
  const [remarks, setRemarks] = useState(job.remarks ?? '');
  const [busy, setBusy] = useState(false);

  async function save() {
    const d = delivery.trim() ? parseUserDate(delivery) : null;
    if (delivery.trim() && !d) return notify('Check the delivery date', 'Use the format 31.12.2026');
    setBusy(true);
    try {
      await updateJob(job.id, { status, tpi_required: tpi, tpi_agency: agency.trim() || null, qap_ref: qap.trim() || null, remarks: remarks.trim() || null, delivery_date: d });
      onDone();
    } catch (e: any) {
      notify('Could not save', e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Muted>Status</Muted>
      <Chips options={EDITABLE_STATUS} value={status} onChange={setStatus} />
      <Toggle label="Third-party inspection (TPI)" value={tpi} onChange={setTpi} />
      {tpi && <Field label="TPI agency" value={agency} onChangeText={setAgency} placeholder="e.g. BV, TÜV, EIL" />}
      <Field label="Customer QAP reference" value={qap} onChangeText={setQap} />
      <Field label="Delivery date" value={delivery} onChangeText={setDelivery} placeholder="31.12.2026" />
      <Field label="Remarks (visible to everyone)" value={remarks} onChangeText={setRemarks} multiline />
      <Button title="Save" onPress={save} busy={busy} />
      <Button title="Cancel" kind="secondary" onPress={onDone} />
    </Card>
  );
}
