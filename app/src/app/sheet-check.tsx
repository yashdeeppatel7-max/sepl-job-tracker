import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Card, Chips, Empty, ErrorBox, Loading, Muted, Pill, Screen } from '../components/ui';
import { lastSync, runSheetCheck, type SheetProblem } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { colors } from '../theme';

type Filter = 'fix' | 'check';

/** Compares every PO in the Google Sheet with what the app shows (Director, CEO, Admin). */
export default function SheetCheck() {
  const q = useQuery(() => Promise.all([runSheetCheck(), lastSync()]), []);
  const [filter, setFilter] = useState<Filter>('fix');

  const groups = useMemo(() => {
    const list = (q.data?.[0].problems ?? []).filter((p) => (filter === 'fix' ? p.serious : !p.serious));
    // one card per PO + problem, listing the items it applies to
    const map = new Map<string, { p: SheetProblem; lines: number[]; details: string[] }>();
    for (const p of list) {
      const key = `${p.job_no}|${p.area}|${p.problem}`;
      const g = map.get(key) ?? { p, lines: [], details: [] };
      if (p.line_no != null) g.lines.push(p.line_no);
      const d = [p.sheet && `Sheet: ${p.sheet}`, p.app && `App: ${p.app}`].filter(Boolean).join('  ·  ');
      if (d && !g.details.includes(d)) g.details.push(d);
      map.set(key, g);
    }
    return [...map.values()].sort((a, b) => a.p.job_no.localeCompare(b.p.job_no));
  }, [q.data, filter]);

  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <Screen><ErrorBox message={q.error} /></Screen>;
  const all = q.data?.[0].problems ?? [];
  const sync = q.data?.[1];
  const nFix = all.filter((p) => p.serious).length;
  const nCheck = all.length - nFix;

  return (
    <Screen refreshing={q.loading} onRefresh={q.reload}>
      <Card>
        <Text style={{ fontWeight: '600', color: colors.text }}>Sheet vs app</Text>
        <Muted>
          Every PO row in the Google Sheet compared with the app: items, invoices, despatch, credit notes,
          Paid / Part paid and PO status.
          {sync ? ` Sheet last synced ${new Date(sync.ran_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}.` : ''}
        </Muted>
      </Card>
      <Chips<Filter>
        options={[{ value: 'fix', label: `Needs fixing (${nFix})` }, { value: 'check', label: `To check (${nCheck})` }]}
        value={filter}
        onChange={setFilter}
      />
      {groups.length === 0 && <Empty text={filter === 'fix' ? 'Nothing to fix. The app matches the sheet.' : 'Nothing to check.'} />}
      {groups.map(({ p, lines, details }) => {
        const id = q.data?.[0].jobIds[p.job_no];
        return (
          <Card key={`${p.job_no}|${p.area}|${p.problem}`} onPress={id ? () => router.push(`/job/${id}`) : undefined}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontWeight: '700', color: colors.text }}>
                {p.job_no}{lines.length ? `  ·  item${lines.length > 1 ? 's' : ''} ${lines.sort((a, b) => a - b).join(', ')}` : ''}
              </Text>
              <Pill label={p.area} tone={p.serious ? 'bad' : 'warn'} />
            </View>
            <Text style={{ color: colors.text, marginTop: 4 }}>{p.problem}</Text>
            {details.slice(0, 4).map((d) => <Muted key={d}>{d}</Muted>)}
          </Card>
        );
      })}
    </Screen>
  );
}
