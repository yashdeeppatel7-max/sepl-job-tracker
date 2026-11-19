import { Ionicons } from '@expo/vector-icons';
import { router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { Card, Chips, Empty, ErrorBox, Loading, Muted, Pill, ProgressBar } from '../../components/ui';
import { getStages, JOB_STATUS_LABEL, listJobs, listJobValues, type JobRow } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, moneyShort } from '../../lib/format';
import { useQuery } from '../../lib/useQuery';
import { colors, space } from '../../theme';

type Filter = 'open' | 'overdue' | 'tpi' | 'completed' | 'all';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'tpi', label: 'TPI' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
];

export default function Jobs() {
  const { perms, role } = useAuth();
  const [filter, setFilter] = useState<Filter>('open');
  const [q, setQ] = useState('');
  const { data, error, loading, reload } = useQuery(async () => {
    const [jobs, values, stages] = await Promise.all([listJobs(), perms.seeMoney ? listJobValues() : Promise.resolve({}), getStages()]);
    return { jobs, values: values as Record<string, number>, stages };
  }, [role]);

  const shown = useMemo(() => {
    if (!data) return [];
    const term = q.trim().toLowerCase();
    return data.jobs.filter((j) => {
      const open = !['completed', 'cancelled'].includes(j.status);
      if (filter === 'open' && !open) return false;
      if (filter === 'overdue' && !j.overdue) return false;
      if (filter === 'tpi' && !(j.tpi_required && open)) return false;
      if (filter === 'completed' && j.status !== 'completed') return false;
      if (!term) return true;
      return [j.job_no, j.customer_code, j.customer_name, j.customer_po_no].some((v) => v?.toLowerCase().includes(term));
    });
  }, [data, filter, q]);

  const counts = useMemo(() => {
    const jobs = data?.jobs ?? [];
    return {
      open: jobs.filter((j) => !['completed', 'cancelled'].includes(j.status)).length,
      overdue: jobs.filter((j) => j.overdue).length,
    };
  }, [data]);

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
        <View style={styles.stats}>
          <Stat label="Open jobs" value={counts.open} />
          <Stat label="Overdue" value={counts.overdue} tone={counts.overdue ? colors.bad : undefined} />
        </View>
        <View style={styles.search}>
          <Ionicons name="search" size={18} color={colors.textFaint} />
          <TextInput value={q} onChangeText={setQ} placeholder="Job no, customer or PO no" placeholderTextColor={colors.textFaint} style={styles.searchInput} autoCapitalize="none" />
        </View>
        <Chips options={FILTERS} value={filter} onChange={setFilter} />
      </View>
      {error && <View style={{ padding: space.md }}><ErrorBox message={error} /></View>}
      {loading && !data ? <Loading /> : (
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

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, tone ? { color: tone } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { padding: space.md, gap: space.sm },
  stats: { flexDirection: 'row', gap: space.sm },
  stat: { flex: 1, backgroundColor: colors.surface, borderRadius: 12, padding: space.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  statValue: { fontSize: 22, fontWeight: '700', color: colors.text },
  statLabel: { fontSize: 12, color: colors.textMuted },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface, borderRadius: 10, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 15, color: colors.text },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  jobNo: { fontSize: 17, fontWeight: '700', color: colors.text },
  customer: { fontSize: 15, color: colors.text, fontWeight: '500' },
  cardFoot: { flexDirection: 'row', alignItems: 'flex-end', gap: space.md, marginTop: 4 },
  value: { fontSize: 15, fontWeight: '700', color: colors.primary },
});
