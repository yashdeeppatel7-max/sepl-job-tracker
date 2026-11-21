import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Card, Muted, Screen, Title } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { lastSync } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { ROLE_LABEL } from '../../lib/roles';
import { colors } from '../../theme';

export default function More() {
  const { profile, role, perms, session, signOut } = useAuth();
  const sync = useQuery(() => (perms.manageJobs ? lastSync() : Promise.resolve(null)), [perms.manageJobs]);
  return (
    <Screen>
      <Card>
        <Title>{profile?.full_name || session?.user.email}</Title>
        <Muted>{session?.user.email}</Muted>
        <Text style={{ color: colors.primary, fontWeight: '600', marginTop: 4 }}>{role ? ROLE_LABEL[role] : 'No role yet'}</Text>
        {!role && <Muted>Ask the Director or CEO to give you a role. Until then you can't see any jobs.</Muted>}
      </Card>
      <Card style={{ padding: 0 }}>
        {perms.importExcel && <Item icon="cloud-upload-outline" label="Import POs from Excel" onPress={() => router.push('/import')} />}
        {perms.manageJobs && <Item icon="add-circle-outline" label="New job / PO" onPress={() => router.push('/job/new')} />}
        {perms.manageUsers && <Item icon="people-outline" label="Users & roles" onPress={() => router.push('/users')} />}
        <Item icon="key-outline" label="Change password" onPress={() => router.push('/password')} />
        <Item icon="log-out-outline" label="Sign out" onPress={signOut} danger last />
      </Card>
      {perms.manageJobs && sync.data && (
        <Card>
          <Text style={{ fontWeight: '600', color: colors.text }}>Google Sheet sync</Text>
          <Muted>
            Last run {new Date(sync.data.ran_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
            {sync.data.ok ? `: ${sync.data.summary?.rows ?? 0} items, ${sync.data.summary?.jobs_new ?? 0} new jobs` : ''}
          </Muted>
          {!sync.data.ok && <Text style={{ color: colors.bad }}>Failed: {sync.data.error}</Text>}
        </Card>
      )}
      <Card>
        <Text style={{ fontWeight: '600', color: colors.text }}>What you can see</Text>
        <Muted>{perms.seeMoney ? '• PO values, invoices, payments and vendor bills' : '• Items and quantities only (no values)'}</Muted>
        <Muted>{perms.updateProductionStages ? '• Update production stages' : '• View production stages'}</Muted>
        {perms.seeDespatch && <Muted>{perms.recordDespatch ? '• Record despatches' : '• View despatch status'}</Muted>}
      </Card>
    </Screen>
  );
}

function Item({ icon, label, onPress, danger, last }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; danger?: boolean; last?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.item, !last && styles.border, pressed && { opacity: 0.6 }]}>
      <Ionicons name={icon} size={22} color={danger ? colors.bad : colors.primary} />
      <Text style={[styles.label, danger && { color: colors.bad }]}>{label}</Text>
      <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
  border: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  label: { flex: 1, fontSize: 16, color: colors.text },
});
