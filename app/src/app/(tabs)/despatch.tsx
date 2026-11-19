import { Ionicons } from '@expo/vector-icons';
import { router, Stack } from 'expo-router';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { Card, Empty, ErrorBox, Loading, Muted, Pill } from '../../components/ui';
import { listDespatches } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date } from '../../lib/format';
import { useQuery } from '../../lib/useQuery';
import { colors, space } from '../../theme';

export default function Despatch() {
  const { perms } = useAuth();
  const { data, error, loading, reload } = useQuery(listDespatches);
  if (!perms.seeDespatch) return <Empty text="Despatch is not available for your role." />;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{
        headerRight: perms.recordDespatch ? () => (
          <Pressable onPress={() => router.push('/despatch/new')} style={{ paddingHorizontal: 16 }} accessibilityLabel="Record despatch">
            <Ionicons name="add" size={26} color="#fff" />
          </Pressable>
        ) : undefined,
      }} />
      {error && <View style={{ padding: space.md }}><ErrorBox message={error} /></View>}
      {loading && !data ? <Loading /> : (
        <FlatList
          data={data ?? []}
          keyExtractor={(d) => d.id}
          contentContainerStyle={{ padding: space.md, gap: space.sm }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
          ListEmptyComponent={<Empty text={perms.recordDespatch ? 'No despatches recorded yet. Tap + to record one.' : 'No despatches recorded yet.'} />}
          renderItem={({ item: d }) => (
            <Card onPress={() => router.push(`/job/${d.job_id}`)}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>{d.job_no}  ·  {d.customer_code}</Text>
                <Pill label={d.documents_sent ? 'Docs sent' : 'Docs pending'} tone={d.documents_sent ? 'good' : 'warn'} />
              </View>
              <Muted>{date(d.despatched_on)}{d.invoice_no ? `  ·  Inv ${d.invoice_no}` : ''}</Muted>
              <Muted>{[d.transporter, d.vehicle_no, d.lr_no && `LR ${d.lr_no}`].filter(Boolean).join('  ·  ') || 'No transport details'}</Muted>
            </Card>
          )}
        />
      )}
    </View>
  );
}
