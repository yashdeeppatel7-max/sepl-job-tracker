import { Ionicons } from '@expo/vector-icons';
import { router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { Card, Chips, Empty, ErrorBox, Loading, Muted, Pill, ProgressBar } from '../../components/ui';
import { getStages, isCancelStage, itemStageText, JOB_STATUS_LABEL, listJobs, listJobValues, listJobReps, listRecentUpdates, REJECT_STAGE, REP_C_ANANT, type JobRow, type RecentUpdate } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, moneyShort } from '../../lib/format';
import { useQuery } from '../../lib/useQuery';
import { colors, space } from '../../theme';

type Filter = 'total' | 'open' | 'ongoing' | 'tpi' | 'completed';
const LATEST = 'latest';
const REP = 'rep-c-anant';
const ALL_OPEN = 'all-open';
const ALL_ONGOING = 'all-ongoing';
const isAll = (p: string) => p === ALL_OPEN || p === ALL_ONGOING || p === LATEST || p === REP;
/** C Anant & Co. POs: marked on the job, or placed by them as the customer. */
const isCAnant = (j: JobRow, reps: Record<string, string>) => reps[j.id] === REP_C_ANANT || /^c\s*anant/i.test(j.customer_code ?? '');

/** Job no. 26-1012 → FY26-27 (job numbers restart each financial year). */
export function fyOf(jobNo: string) {
  const yy = Number(jobNo.slice(0, 2));
  return Number.isFinite(yy) ? `FY${String(yy).padStart(2, '0')}-${String((yy + 1) % 100).padStart(2, '0')}` : 'Other';
}
const isPending = (j: JobRow) => !['completed', 'cancelled'].includes(j.status);
const isStarted = (j: JobRow) => j.slowest_stage_seq != null || j.items_despatched > 0 || j.status === 'in_progress';

function matches(j: JobRow, f: Filter) {
  switch (f) {
    case 'total': return true;
    case 'open': return isPending(j);
    case 'ongoing': return isPending(j) && isStarted(j);
    case 'tpi': return j.tpi_required;
    case 'completed': return j.status === 'completed';
  }
}

export default function Jobs() {
  const { perms, role } = useAuth();
  const [period, setPeriod] = useState<string>(ALL_OPEN);
  const [filter, setFilter] = useState<Filter>('total');
  const [q, setQ] = useState('');
  const [openPo, setOpenPo] = useState<string | null>(null);
  const { data, error, loading, reload } = useQuery(async () => {
    const [jobs, values, stages, recent, reps] = await Promise.all([listJobs(), perms.seeMoney ? listJobValues() : Promise.resolve({}), getStages(), listRecentUpdates(15),
      perms.manageJobs ? listJobReps() : Promise.resolve({} as Record<string, string>)]);
    return { jobs, values: values as Record<string, number>, stages, recent, reps };
  }, [role]);

  const years = useMemo(() => {
    const set = new Set((data?.jobs ?? []).map((j) => fyOf(j.job_no)));
    return [...set].sort().reverse();
  }, [data]);

  // jobs in the chosen period, before the status filter
  const inPeriod = useMemo(() => {
    const jobs = data?.jobs ?? [];
    if (period === REP) return jobs.filter((j) => isCAnant(j, data?.reps ?? {}));
    if (period === ALL_OPEN) return jobs.filter(isPending);
    if (period === ALL_ONGOING) return jobs.filter((j) => matches(j, 'ongoing'));
    return jobs.filter((j) => fyOf(j.job_no) === period);
  }, [data, period]);

  const counts = useMemo(() => {
    const c = { total: 0, open: 0, ongoing: 0, tpi: 0, completed: 0 } as Record<Filter, number>;
    for (const j of inPeriod) for (const f of Object.keys(c) as Filter[]) if (matches(j, f)) c[f]++;
    return c;
  }, [inPeriod]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return inPeriod.filter((j) => {
      if (!isAll(period) && !matches(j, filter)) return false;
      if (!term) return true;
      return [j.job_no, j.customer_code, j.customer_name, j.customer_po_no].some((v) => v?.toLowerCase().includes(term));
    });
  }, [inPeriod, period, filter, q]);

  const periodTotal = useMemo(
    () => (perms.seeMoney && data ? shown.reduce((s, j) => s + (data.values[j.id] ?? 0), 0) : null),
    [shown, data, perms.seeMoney],
  );
  const overdue = shown.filter((j) => j.overdue).length;

  const periodOptions = [...(perms.manageJobs ? [{ value: REP, label: REP_C_ANANT }] : []), { value: LATEST, label: 'Latest updated' }, { value: ALL_OPEN, label: `All open POs` }, { value: ALL_ONGOING, label: `All ongoing POs` }, ...years.map((y) => ({ value: y, label: y }))];
  const filterOptions: { value: Filter; label: string }[] = [
    { value: 'total', label: `Total PO received (${counts.total})` },
    { value: 'open', label: `Open PO (${counts.open})` },
    { value: 'ongoing', label: `PO on-going (${counts.ongoing})` },
    { value: 'tpi', label: `TPI (${counts.tpi})` },
    { value: 'completed', label: `Completed (${counts.completed})` },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{
        headerRight: perms.manageJobs ? () => (
          <Pressable onPress={() => router.push('/job/new')} style={{ paddingHorizontal: 16 }} accessibilityLabel="New job">
            <Ionicons name="add" size={26} color="#fff" />
          </Pressable>
        ) : undefined,
      }} />
      <View style={styles.top}>
        <Chips options={periodOptions} value={period} onChange={(v) => { setPeriod(v); setFilter('total'); }} />
        {!isAll(period) && <Chips options={filterOptions} value={filter} onChange={setFilter} />}
        {period !== LATEST && <View style={styles.stats}>
          <Stat label={period === REP ? `${REP_C_ANANT} POs` : period === ALL_OPEN ? 'Open POs, all years' : period === ALL_ONGOING ? 'Ongoing POs, all years' : 'POs shown'} value={String(shown.length)} />
          <Stat label="Overdue" value={String(overdue)} tone={overdue ? colors.bad : undefined} />
          {periodTotal != null && <Stat label="Value incl. GST" value={moneyShort(periodTotal)} />}
        </View>}
        <View style={styles.search}>
          <Ionicons name="search" size={18} color={colors.textFaint} />
          <TextInput value={q} onChangeText={setQ} placeholder="Job no, customer or PO no" placeholderTextColor={colors.textFaint} style={styles.searchInput} autoCapitalize="none" />
        </View>
      </View>
      {error && <View style={{ padding: space.md }}><ErrorBox message={error} /></View>}
      {loading && !data ? <Loading /> : period === LATEST ? (
        <FlatList
          data={groupByPo((data?.recent ?? []).filter((u) => {
            const term = q.trim().toLowerCase();
            if (!term) return true;
            const j = u.line_items?.jobs;
            return [j?.job_no, j?.customers?.code, u.created_by_name, u.line_items?.description].some((v) => v?.toLowerCase().includes(term));
          }))}
          keyExtractor={(g) => g.jobId}
          contentContainerStyle={{ padding: space.md, paddingTop: 0, gap: space.sm }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
          ListHeaderComponent={<Muted>POs updated in the app in the last 15 days, newest first. Tap a PO to see its items.</Muted>}
          ListEmptyComponent={<Empty text="No updates in the last 15 days." />}
          renderItem={({ item }) => <PoUpdates g={item} stages={data!.stages} open={openPo === item.jobId} onToggle={() => setOpenPo(openPo === item.jobId ? null : item.jobId)} />}
        />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(j) => j.id}
          contentContainerStyle={{ padding: space.md, paddingTop: 0, gap: space.sm }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
          ListEmptyComponent={<Empty text="No jobs match." />}
          renderItem={({ item }) => <JobCard job={item} value={data?.values[item.id]} stageLabel={stageText(item, data!.stages)} />}
        />
      )}
    </View>
  );
}

function stageText(j: JobRow, stages: { seq: number; label: string }[]) {
  if (j.status === 'completed') return 'All despatched';
  if (j.status === 'cancelled') return 'Cancelled';
  if (j.slowest_stage_seq == null) return 'Not started';
  return stages.find((s) => s.seq === j.slowest_stage_seq)?.label ?? '';
}

function JobCard({ job, value, stageLabel }: { job: JobRow; value?: number; stageLabel: string }) {
  const tone = job.status === 'completed' ? 'good' : job.status === 'cancelled' ? 'bad' : job.overdue ? 'bad' : job.status === 'on_hold' ? 'warn' : 'info';
  return (
    <Card onPress={() => router.push(`/job/${job.id}`)}>
      <View style={styles.cardHead}>
        <Text style={styles.jobNo}>{job.job_no}</Text>
        <Pill label={job.overdue ? 'Overdue' : JOB_STATUS_LABEL[job.status]} tone={tone} />
      </View>
      <Text style={styles.customer}>{job.customer_code}{job.tpi_required ? '  ·  TPI' : ''}</Text>
      <Muted>PO {job.customer_po_no ?? '–'}  ·  Due {date(job.delivery_date)}</Muted>
      <View style={styles.cardFoot}>
        <View style={{ flex: 1, gap: 4 }}>
          <Muted>{job.items_despatched}/{job.item_count} items despatched  ·  {stageLabel}</Muted>
          <ProgressBar value={job.item_count ? job.items_despatched / job.item_count : 0} />
        </View>
        {value != null && <Text style={styles.value}>{moneyShort(value)}</Text>}
      </View>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, tone ? { color: tone } : null]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { padding: space.md, gap: space.sm },
  stats: { flexDirection: 'row', gap: space.sm },
  stat: { flex: 1, backgroundColor: colors.surface, borderRadius: 12, padding: space.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  statValue: { fontSize: 20, fontWeight: '700', color: colors.text },
  statLabel: { fontSize: 12, color: colors.textMuted },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface, borderRadius: 10, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 15, color: colors.text },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  subRow: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8, marginTop: 4, gap: 2 },
  jobNo: { fontSize: 17, fontWeight: '700', color: colors.text },
  customer: { fontSize: 15, color: colors.text, fontWeight: '500' },
  cardFoot: { flexDirection: 'row', alignItems: 'flex-end', gap: space.md, marginTop: 4 },
  value: { fontSize: 15, fontWeight: '700', color: colors.primary },
});

type PoGroup = { jobId: string; jobNo: string; customer: string; updates: RecentUpdate[] };
function groupByPo(list: RecentUpdate[]): PoGroup[] {
  const map = new Map<string, PoGroup>();
  for (const u of list) {           // list is newest first, so groups come out newest first
    const j = u.line_items?.jobs;
    if (!j) continue;
    if (!map.has(j.id)) map.set(j.id, { jobId: j.id, jobNo: j.job_no, customer: j.customers?.code ?? '', updates: [] });
    map.get(j.id)!.updates.push(u);
  }
  return [...map.values()];
}

function PoUpdates({ g, stages, open, onToggle }: { g: PoGroup; stages: any[]; open: boolean; onToggle: () => void }) {
  const latest = g.updates[0];
  const items = new Set(g.updates.map((u) => u.line_items?.id)).size;
  const people = [...new Set(g.updates.map((u) => u.created_by_name).filter(Boolean))].join(', ');
  return (
    <Card onPress={onToggle}>
      <View style={styles.cardHead}>
        <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>{g.jobNo}  ·  {g.customer}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
      </View>
      <Text style={{ color: colors.text }}>Item status updated  ·  {items} item{items === 1 ? '' : 's'}, {g.updates.length} update{g.updates.length === 1 ? '' : 's'}</Text>
      <Muted>Last: {date(latest.happened_on)}{people ? `  ·  by ${people}` : ''}</Muted>
      {open && g.updates.map((u) => {
        const bad = isCancelStage(u.stage_code) || u.stage_code === REJECT_STAGE;
        return (
          <Pressable key={u.id} onPress={() => u.line_items && router.push(`/item/${u.line_items.id}`)} style={styles.subRow}>
            <View style={styles.cardHead}>
              <Text style={{ color: colors.text, fontWeight: '600', flex: 1 }}>{u.line_items ? `${u.line_items.line_no}. ${u.line_items.description}` : ''}</Text>
              <Pill label={itemStageText(stages, u.stage_code, u.status)} tone={bad ? 'bad' : u.status === 'done' ? 'good' : 'info'} />
            </View>
            <Muted>
              {u.created_by_name ? `by ${u.created_by_name}` : 'by someone'}  ·  {date(u.happened_on)}
              {u.mode === 'job_work' ? `  ·  Job work${u.vendors ? `: ${u.vendors.name}` : ''}` : ''}
              {u.edited_at ? `  ·  edited${u.edited_by_name ? ` by ${u.edited_by_name}` : ''}` : ''}
            </Muted>
            {u.note ? <Text style={{ color: colors.text }}>{u.note}</Text> : null}
          </Pressable>
        );
      })}
    </Card>
  );
}
