import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Card, Chips, ErrorBox, Field, Loading, Muted, Pill, Screen, Section, Toggle } from '../../components/ui';
import { addStageEvent, deleteStageEvent, getItem, listItemInvoices, updateStageEvent, getStages, isCancelStage, itemStageText, REJECT_STAGE, setNeedsRectification, stageLabel, type Stage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, money, parseUserDate, todayIso, toUserDate, workAndEntry } from '../../lib/format';
import { useQuery } from '../../lib/useQuery';
import { colors, space } from '../../theme';
import { notify } from '../../lib/notify';

type Status = 'in_progress' | 'done' | 'skipped';
type Mode = 'in_house' | 'job_work';

export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { perms, session } = useAuth();
  const [editing, setEditing] = useState<string | null>(null);
  const { data, error, loading, reload } = useQuery(async () => {
    const [{ item, events }, stages, invoices] = await Promise.all([getItem(id), getStages(), perms.seeMoney ? listItemInvoices(id) : Promise.resolve([])]);
    return { item, events, stages, invoices };
  }, [id, perms.seeMoney]);

  const [stageCode, setStageCode] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('done');
  const [mode, setMode] = useState<Mode>('in_house');
  const [vendor, setVendor] = useState('');
  const [on, setOn] = useState(toUserDate(todayIso()));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Stages that apply to this item, in order
  const applicable = useMemo(() => {
    if (!data) return [] as Stage[];
    return data.stages.filter((s) =>
      s.optional_for == null ||
      (s.optional_for === 'tpi' && data.item.jobs.tpi_required) ||
      (s.optional_for === 'rectification' && data.item.needs_rectification));
  }, [data]);

  const mayUpdateCode = (code: string) => { const s = data?.stages.find((x) => x.code === code); return s ? mayUpdate(s) : false; };
  const mayUpdate = (s: Stage) =>
    s.owner === 'production' ? perms.updateProductionStages : s.owner === 'mgmt' ? perms.manageJobs : perms.updateFinanceStages;

  // Default the picker to the next stage this user may record
  const suggested = useMemo(() => {
    if (!data) return null;
    const cur = data.stages.find((s) => s.code === data.item.current_stage);
    const startSeq = cur ? (data.item.current_status === 'in_progress' ? cur.seq - 1 : cur.seq) : -1;
    if (isCancelStage(data.item.current_stage)) return null;
    return applicable.find((s) => s.seq > startSeq && !isCancelStage(s.code) && s.code !== REJECT_STAGE && mayUpdate(s)) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, applicable]);
  const selected = stageCode ?? suggested?.code ?? null;

  if (error) return <Screen><ErrorBox message={error} /></Screen>;
  if (!data) return <Loading />;
  const { item, events, stages } = data;
  // after a rejection only the new cycle counts as progress
  const lastReject = events.filter((e) => e.stage_code === REJECT_STAGE).map((e) => e.created_at).sort().pop();
  const cycle = lastReject ? events.filter((e) => e.created_at >= lastReject) : events;
  const doneCodes = new Set(cycle.filter((e) => e.status !== 'in_progress' && e.stage_code !== REJECT_STAGE).map((e) => e.stage_code));
  const curSeq = stages.find((s) => s.code === item.current_stage)?.seq ?? -1;
  const canAnything = perms.updateProductionStages || perms.updateFinanceStages;
  const cancelled = isCancelStage(item.current_stage);
  const cancelSelected = isCancelStage(selected) || selected === REJECT_STAGE;
  const curStage = stages.find((s) => s.code === item.current_stage);
  const canReject = !cancelled && (curStage?.seq ?? 0) >= 130; // invoiced or later

  async function save() {
    if (!selected) return;
    const d = parseUserDate(on);
    if (!d) return notify('Check the date', 'Use the format 31.12.2026');
    if (mode === 'job_work' && !vendor.trim()) return notify('Vendor needed', 'Enter the job-work vendor name.');
    setBusy(true);
    try {
      await addStageEvent({ line_item_id: item.id, stage_code: selected, status: cancelSelected ? 'done' : status, mode, vendor_name: vendor, note, happened_on: d });
      setStageCode(null); setNote(''); setVendor(''); setStatus('done'); setMode('in_house');
      await reload();
    } catch (e: any) {
      notify('Could not save', e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Stack.Screen options={{ title: `${item.jobs.job_no} · item ${item.line_no}` }} />
      <Card>
        <Text style={styles.desc}>{item.description}</Text>
        <Muted>{item.jobs.customers?.code}  ·  Code {item.item_code ?? '–'}  ·  Qty {item.qty} {item.unit}</Muted>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
          <Pill label={itemStageText(stages, item.current_stage, item.current_status)} tone={cancelled || item.current_stage === REJECT_STAGE ? 'bad' : 'info'} />
          {item.jobs.tpi_required && <Pill label="TPI" tone="warn" />}
          {item.needs_rectification && <Pill label="Rectification" tone="bad" />}
        </View>
        {perms.updateProductionStages && (
          <Toggle label="Defects found, needs rectification" value={item.needs_rectification}
            onChange={async (v) => { try { await setNeedsRectification(item.id, v); reload(); } catch (e: any) { notify('Could not save', e.message); } }} />
        )}
      </Card>

      {canAnything && (
        <Section title="Update stage">
          <Card>
            <Muted>Stage</Muted>
            <View style={styles.stageGrid}>
              {applicable.filter(mayUpdate).filter((s) => s.code !== REJECT_STAGE || canReject).map((s) => {
                const active = s.code === selected;
                return (
                  <Pressable key={s.code} onPress={() => setStageCode(s.code)} style={[styles.stageBtn, (isCancelStage(s.code) || s.code === REJECT_STAGE) && styles.cancelBtn, active && styles.stageBtnActive, active && (isCancelStage(s.code) || s.code === REJECT_STAGE) && styles.cancelBtnActive]}>
                    <Text style={[styles.stageBtnText, (isCancelStage(s.code) || s.code === REJECT_STAGE) && { color: colors.bad }, active && { color: '#fff' }]}>{s.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            {selected === REJECT_STAGE && <Text style={styles.warn}>The item goes back to the start (raw material ordered) and the PO reopens. Earlier updates stay in the history. Write the rejection reason in the note. Accounts can add the credit note from the job's Invoices section.</Text>}
            {selected === 'item_cancelled' && <Text style={styles.warn}>This item will be marked cancelled. Add the reason in the note (e.g. drawing mismatch).</Text>}
            {selected === 'po_cancelled' && <Text style={styles.warn}>The whole PO {item.jobs.job_no} will be short-closed: every item is marked cancelled and the job becomes Cancelled.</Text>}
            {!cancelSelected && (
              <>
                <Muted>Status</Muted>
                <Chips<Status> value={status} onChange={setStatus} options={[
                  { value: 'in_progress', label: selected === 'despatched' ? 'Part despatched' : 'Started' }, { value: 'done', label: selected === 'despatched' ? 'Fully despatched' : 'Done' }, { value: 'skipped', label: 'Not needed' },
                ]} />
              </>
            )}
            {stages.find((s) => s.code === selected)?.owner === 'production' && (
              <>
                <Muted>Where</Muted>
                <Chips<Mode> value={mode} onChange={setMode} options={[
                  { value: 'in_house', label: 'In-house' }, { value: 'job_work', label: 'Job work (outside)' },
                ]} />
                {mode === 'job_work' && <Field label="Vendor" value={vendor} onChangeText={setVendor} placeholder="Job-work vendor name" />}
              </>
            )}
            <Field label="Date" value={on} onChangeText={setOn} placeholder="31.12.2026" />
            <Field label="Note" value={note} onChangeText={setNote} placeholder="e.g. heat no., test report no., TPI inspector" multiline />
            <Button title="Save update" onPress={save} busy={busy} disabled={!selected} icon="checkmark" />
          </Card>
        </Section>
      )}

      <Section title="Progress">
        <Card>
          {lastReject && <Text style={styles.warn}>Rework after customer rejection on {date(events.find((e) => e.created_at === lastReject)?.happened_on ?? null)}</Text>}
          {applicable.filter((s) => s.code !== REJECT_STAGE && (!isCancelStage(s.code) || s.code === item.current_stage)).map((s) => {
            const done = doneCodes.has(s.code) || (!cancelled && s.seq < curSeq);
            const current = s.code === item.current_stage && item.current_status === 'in_progress';
            return (
              <View key={s.code} style={styles.step}>
                <Ionicons
                  name={isCancelStage(s.code) ? 'close-circle' : done ? 'checkmark-circle' : current ? 'ellipse' : 'ellipse-outline'}
                  size={20}
                  color={isCancelStage(s.code) ? colors.bad : done ? colors.good : current ? colors.info : colors.textFaint}
                />
                <Text style={[styles.stepText, !done && !current && { color: colors.textMuted }]}>{s.label}</Text>
                {s.optional_for && <Text style={styles.optional}>{s.optional_for === 'tpi' ? 'TPI' : 'if defects'}</Text>}
              </View>
            );
          })}
        </Card>
      </Section>

      {data.invoices.length > 0 && (
        <Section title="Invoices for this item">
          {data.invoices.map((inv) => (
            <Card key={inv.id} onPress={() => router.push(`/invoice/${inv.id}`)}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontWeight: '700', color: colors.text }}>{inv.is_credit_note ? 'Credit note' : 'Inv'} {inv.invoice_no}</Text>
                <Pill label={inv.is_credit_note ? 'Credit note' : inv.payment_status === 'paid' ? 'Paid' : inv.payment_status === 'part_paid' ? 'Part paid' : 'Unpaid'}
                  tone={inv.is_credit_note ? 'neutral' : inv.payment_status === 'paid' ? 'good' : inv.payment_status === 'part_paid' ? 'warn' : 'bad'} />
              </View>
              <Muted>{date(inv.invoice_date)}  ·  {inv.amount == null ? 'amount not entered' : money(inv.amount)}</Muted>
            </Card>
          ))}
        </Section>
      )}

      <Section title="History">
        {events.length === 0 ? <Muted>No updates yet.</Muted> : events.map((e) => (
          <Card key={e.id}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.sm }}>
              <Text style={{ fontWeight: '600', color: colors.text, flex: 1 }}>{stageLabel(stages, e.stage_code)}</Text>
              <Pill label={e.stage_code === REJECT_STAGE ? 'Rejected' : isCancelStage(e.stage_code) ? 'Cancelled' : (e.stage_code === 'despatched' || e.stage_code === 'payment_received') && e.status === 'in_progress' ? 'Part' : e.status === 'done' ? 'Done' : e.status === 'in_progress' ? 'Started' : 'Not needed'} tone={isCancelStage(e.stage_code) || e.stage_code === REJECT_STAGE ? 'bad' : e.status === 'done' ? 'good' : e.status === 'in_progress' ? 'info' : 'neutral'} />
            </View>
            <Muted>
              {workAndEntry(e.happened_on, e.created_at)}
              {e.mode === 'job_work' ? `  ·  Job work${e.vendors ? `: ${e.vendors.name}` : ''}` : ''}
              {(e.created_by_name || e.profiles?.full_name) ? `  ·  by ${e.created_by_name || e.profiles?.full_name}` : ''}
            </Muted>
            {e.note ? <Text style={{ color: colors.text }}>{e.note}</Text> : null}
            {e.edited_at ? <Muted>Edited{e.edited_by_name ? ` by ${e.edited_by_name}` : ''} on {date(e.edited_at.slice(0, 10))}</Muted> : null}
            {editing === e.id
              ? <EditEvent ev={e} onDone={() => { setEditing(null); reload(); }} />
              : (perms.manageJobs || (e.created_by === session?.user.id && mayUpdateCode(e.stage_code))) &&
                <Text style={styles.link} onPress={() => setEditing(e.id)}>Edit</Text>}
          </Card>
        ))}
      </Section>
    </Screen>
  );
}

function EditEvent({ ev, onDone }: { ev: { id: string; status: string; note: string | null; happened_on: string; stage_code: string }; onDone: () => void }) {
  const [st, setSt] = useState<Status>(ev.status as Status);
  const [on, setOn] = useState(toUserDate(ev.happened_on));
  const [note, setNote] = useState(ev.note ?? '');
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); onDone(); } catch (e: any) { notify('Could not save', e.message); } finally { setBusy(false); }
  }
  return (
    <View style={{ gap: 6, marginTop: 6 }}>
      {!isCancelStage(ev.stage_code) && ev.stage_code !== REJECT_STAGE && (
        <Chips<Status> value={st} onChange={setSt} options={[
          { value: 'in_progress', label: ev.stage_code === 'despatched' ? 'Part despatched' : 'Started' },
          { value: 'done', label: ev.stage_code === 'despatched' ? 'Fully despatched' : 'Done' },
          { value: 'skipped', label: 'Not needed' },
        ]} />
      )}
      <Field label="Date" value={on} onChangeText={setOn} placeholder="31.12.2026" />
      <Field label="Note" value={note} onChangeText={setNote} multiline />
      <Button title="Save changes" busy={busy} onPress={() => {
        const d = parseUserDate(on);
        if (!d) return notify('Check the date', 'Use the format 31.12.2026');
        run(() => updateStageEvent(ev.id, { status: st, happened_on: d, note: note.trim() || null }));
      }} />
      <Button title={confirmDel ? 'Tap again to delete this update' : 'Delete this update'} kind="secondary" busy={busy}
        onPress={() => (confirmDel ? run(() => deleteStageEvent(ev.id)) : setConfirmDel(true))} />
      <Button title="Cancel" kind="secondary" onPress={onDone} />
    </View>
  );
}

const styles = StyleSheet.create({
  link: { color: colors.info, fontWeight: '600', marginTop: 4 },
  desc: { fontSize: 16, fontWeight: '600', color: colors.text },
  stageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  stageBtn: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  stageBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  stageBtnText: { fontSize: 13, color: colors.text },
  cancelBtn: { borderColor: colors.bad },
  cancelBtnActive: { backgroundColor: colors.bad, borderColor: colors.bad },
  warn: { color: colors.bad, fontSize: 13 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 5 },
  stepText: { fontSize: 14, color: colors.text, flex: 1 },
  optional: { fontSize: 11, color: colors.warn, fontWeight: '600' },
});
