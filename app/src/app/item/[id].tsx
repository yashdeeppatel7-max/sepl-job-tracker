import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Card, Chips, ErrorBox, Field, Loading, Muted, Pill, Screen, Section, Toggle } from '../../components/ui';
import { addStageEvent, getItem, getStages, isCancelStage, itemStageText, setNeedsRectification, stageLabel, type Stage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, parseUserDate, todayIso, toUserDate } from '../../lib/format';
import { useQuery } from '../../lib/useQuery';
import { colors, space } from '../../theme';
import { notify } from '../../lib/notify';

type Status = 'in_progress' | 'done' | 'skipped';
type Mode = 'in_house' | 'job_work';

export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { perms } = useAuth();
  const { data, error, loading, reload } = useQuery(async () => {
    const [{ item, events }, stages] = await Promise.all([getItem(id), getStages()]);
    return { item, events, stages };
  }, [id]);

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

  const mayUpdate = (s: Stage) =>
    s.owner === 'production' ? perms.updateProductionStages : s.owner === 'mgmt' ? perms.manageJobs : perms.updateFinanceStages;

  // Default the picker to the next stage this user may record
  const suggested = useMemo(() => {
    if (!data) return null;
    const cur = data.stages.find((s) => s.code === data.item.current_stage);
    const startSeq = cur ? (data.item.current_status === 'in_progress' ? cur.seq - 1 : cur.seq) : -1;
    if (isCancelStage(data.item.current_stage)) return null;
    return applicable.find((s) => s.seq > startSeq && !isCancelStage(s.code) && mayUpdate(s)) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, applicable]);
  const selected = stageCode ?? suggested?.code ?? null;

  if (error) return <Screen><ErrorBox message={error} /></Screen>;
  if (!data) return <Loading />;
  const { item, events, stages } = data;
  const doneCodes = new Set(events.filter((e) => e.status !== 'in_progress').map((e) => e.stage_code));
  const curSeq = stages.find((s) => s.code === item.current_stage)?.seq ?? -1;
  const canAnything = perms.updateProductionStages || perms.updateFinanceStages;
  const cancelled = isCancelStage(item.current_stage);
  const cancelSelected = isCancelStage(selected);

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
          <Pill label={itemStageText(stages, item.current_stage, item.current_status)} tone={cancelled ? 'bad' : 'info'} />
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
              {applicable.filter(mayUpdate).map((s) => {
                const active = s.code === selected;
                return (
                  <Pressable key={s.code} onPress={() => setStageCode(s.code)} style={[styles.stageBtn, isCancelStage(s.code) && styles.cancelBtn, active && styles.stageBtnActive, active && isCancelStage(s.code) && styles.cancelBtnActive]}>
                    <Text style={[styles.stageBtnText, isCancelStage(s.code) && { color: colors.bad }, active && { color: '#fff' }]}>{s.label}</Text>
                  </Pressable>
                );
              })}
            </View>
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
          {applicable.filter((s) => !isCancelStage(s.code) || s.code === item.current_stage).map((s) => {
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

      <Section title="History">
        {events.length === 0 ? <Muted>No updates yet.</Muted> : events.map((e) => (
          <Card key={e.id}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.sm }}>
              <Text style={{ fontWeight: '600', color: colors.text, flex: 1 }}>{stageLabel(stages, e.stage_code)}</Text>
              <Pill label={isCancelStage(e.stage_code) ? 'Cancelled' : e.stage_code === 'despatched' && e.status === 'in_progress' ? 'Part' : e.status === 'done' ? 'Done' : e.status === 'in_progress' ? 'Started' : 'Not needed'} tone={isCancelStage(e.stage_code) ? 'bad' : e.status === 'done' ? 'good' : e.status === 'in_progress' ? 'info' : 'neutral'} />
            </View>
            <Muted>
              {date(e.happened_on)}
              {e.mode === 'job_work' ? `  ·  Job work${e.vendors ? `: ${e.vendors.name}` : ''}` : ''}
              {e.profiles?.full_name ? `  ·  by ${e.profiles.full_name}` : ''}
            </Muted>
            {e.note ? <Text style={{ color: colors.text }}>{e.note}</Text> : null}
          </Card>
        ))}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
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
