import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Card, Chips, Field, Muted, Screen, Section, Toggle } from '../../components/ui';
import { createJob, type JobStatus } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { parseNumber, parseUserDate, todayIso, toUserDate } from '../../lib/format';
import { colors } from '../../theme';
import { notify } from '../../lib/notify';

type ItemDraft = { description: string; item_code: string; qty: string; rate: string; gst: string };
const blank = (): ItemDraft => ({ description: '', item_code: '', qty: '1', rate: '', gst: '18' });

export default function NewJob() {
  const { perms } = useAuth();
  const [jobNo, setJobNo] = useState('');
  const [customer, setCustomer] = useState('');
  const [poNo, setPoNo] = useState('');
  const [poDate, setPoDate] = useState(toUserDate(todayIso()));
  const [delivery, setDelivery] = useState('');
  const [tpi, setTpi] = useState(false);
  const [status, setStatus] = useState<JobStatus>('po_received');
  const [items, setItems] = useState<ItemDraft[]>([blank()]);
  const [busy, setBusy] = useState(false);

  const setItem = (i: number, patch: Partial<ItemDraft>) => setItems(items.map((it, k) => (k === i ? { ...it, ...patch } : it)));

  async function save() {
    if (!/^\d{2}-\d{3,5}$/.test(jobNo.trim())) return notify('Job no. should look like 26-1046');
    if (!customer.trim()) return notify('Enter the customer');
    const pd = poDate.trim() ? parseUserDate(poDate) : null;
    const dd = delivery.trim() ? parseUserDate(delivery) : null;
    if ((poDate.trim() && !pd) || (delivery.trim() && !dd)) return notify('Check the dates', 'Use the format 31.12.2026');
    const clean = items.filter((it) => it.description.trim());
    if (!clean.length) return notify('Add at least one item');
    for (const it of clean) if (!parseNumber(it.qty)) return notify(`Check the quantity for "${it.description}"`);
    setBusy(true);
    try {
      const id = await createJob({
        job_no: jobNo, customer, customer_po_no: poNo, po_date: pd, delivery_date: dd, tpi_required: tpi, status,
        items: clean.map((it) => ({
          description: it.description, item_code: it.item_code, qty: parseNumber(it.qty)!,
          rate: perms.seeMoney ? parseNumber(it.rate) : null, gst_pct: parseNumber(it.gst) ?? 18,
        })),
      });
      router.replace(`/job/${id}`);
    } catch (e: any) {
      notify('Could not save', e.message.includes('duplicate') ? `Job ${jobNo} already exists.` : e.message);
    } finally { setBusy(false); }
  }

  return (
    <Screen>
      <Card>
        <Field label="Job no. (SEPL P.O No.)" value={jobNo} onChangeText={setJobNo} placeholder="26-1046" autoCapitalize="none" />
        <Field label="Customer" value={customer} onChangeText={setCustomer} placeholder="RIL-JAM" autoCapitalize="characters" />
        <Field label="Customer PO no." value={poNo} onChangeText={setPoNo} />
        <Field label="PO date" value={poDate} onChangeText={setPoDate} placeholder="31.12.2026" />
        <Field label="Delivery date" value={delivery} onChangeText={setDelivery} placeholder="31.12.2026" />
        <Toggle label="Third-party inspection (TPI)" value={tpi} onChange={setTpi} />
        <Muted>Stage</Muted>
        <Chips<JobStatus> value={status} onChange={setStatus} options={[
          { value: 'enquiry', label: 'Enquiry' }, { value: 'quoted', label: 'Quoted' }, { value: 'po_received', label: 'PO received' },
        ]} />
      </Card>
      <Section title="Items">
        {items.map((it, i) => (
          <Card key={i}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontWeight: '600', color: colors.text }}>Item {i + 1}</Text>
              {items.length > 1 && <Text style={{ color: colors.bad }} onPress={() => setItems(items.filter((_, k) => k !== i))}>Remove</Text>}
            </View>
            <Field label="Description" value={it.description} onChangeText={(v) => setItem(i, { description: v })} multiline placeholder="SHAFT; MOC: SS316; PN 317133" />
            <Field label="Item code" value={it.item_code} onChangeText={(v) => setItem(i, { item_code: v })} />
            <Field label="Qty" value={it.qty} onChangeText={(v) => setItem(i, { qty: v })} keyboardType="decimal-pad" />
            {perms.seeMoney && (
              <>
                <Field label="Rate per unit (₹, before GST)" value={it.rate} onChangeText={(v) => setItem(i, { rate: v })} keyboardType="decimal-pad" />
                <Field label="GST %" value={it.gst} onChangeText={(v) => setItem(i, { gst: v })} keyboardType="decimal-pad" />
              </>
            )}
          </Card>
        ))}
        <Button title="Add another item" kind="secondary" icon="add" onPress={() => setItems([...items, blank()])} />
      </Section>
      <Button title="Create job" onPress={save} busy={busy} />
    </Screen>
  );
}
