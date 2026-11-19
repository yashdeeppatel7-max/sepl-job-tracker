import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { Button, Card, Chips, Empty, ErrorBox, Field, Loading, Muted, Pill, Screen, Section, Toggle } from '../components/ui';
import { createUser, listProfiles, updateProfile, type ProfileRow } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL, ROLES, type Role } from '../lib/roles';
import { useQuery } from '../lib/useQuery';
import { colors } from '../theme';

const roleOptions = ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }));

export default function Users() {
  const { perms, session } = useAuth();
  const { data, error, loading, reload } = useQuery(listProfiles);
  const [adding, setAdding] = useState(false);
  if (!perms.manageUsers) return <Empty text="Only the Director or CEO can manage users." />;
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      {error && <ErrorBox message={error} />}
      {adding ? <AddUser onDone={() => { setAdding(false); reload(); }} /> : <Button title="Add a user" icon="person-add-outline" onPress={() => setAdding(true)} />}
      <Section title="Everyone">
        {!data ? <Loading /> : data.map((p) => <UserCard key={p.id} p={p} self={p.id === session?.user.id} onChange={reload} />)}
      </Section>
    </Screen>
  );
}

function UserCard({ p, self, onChange }: { p: ProfileRow; self: boolean; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  async function save(patch: { role?: string | null; active?: boolean }) {
    try { await updateProfile(p.id, patch); onChange(); } catch (e: any) { Alert.alert('Could not save', e.message); }
  }
  return (
    <Card onPress={() => setOpen(!open)}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text }}>{p.full_name || '(no name)'}{self ? ' (you)' : ''}</Text>
        <Pill label={!p.active ? 'Disabled' : p.role ? ROLE_LABEL[p.role as Role] : 'No role'} tone={!p.active ? 'bad' : p.role ? 'info' : 'warn'} />
      </View>
      {open && !self && (
        <>
          <Muted>Role</Muted>
          <Chips<Role> options={roleOptions} value={(p.role ?? '') as Role} onChange={(r) => save({ role: r })} />
          <Toggle label="Can sign in" value={p.active} onChange={(v) => save({ active: v })} />
        </>
      )}
      {open && self && <Muted>You can't change your own role. Ask the other owner (Director or CEO).</Muted>}
    </Card>
  );
}

function AddUser({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('production_manager');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!name.trim() || !email.trim()) return Alert.alert('Enter name and email');
    if (password.length < 8) return Alert.alert('Temporary password needs at least 8 characters');
    setBusy(true);
    try {
      await createUser({ email: email.trim(), password, full_name: name.trim(), role });
      Alert.alert('User added', `Share the email and temporary password with ${name}. They can change it under More → Change password.`);
      onDone();
    } catch (e: any) { Alert.alert('Could not add user', e.message); } finally { setBusy(false); }
  }
  return (
    <Card>
      <Field label="Full name" value={name} onChangeText={setName} />
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
      <Field label="Temporary password" value={password} onChangeText={setPassword} autoCapitalize="none" hint="At least 8 characters" />
      <Muted>Role</Muted>
      <Chips<Role> options={roleOptions} value={role} onChange={setRole} />
      <Button title="Add user" onPress={save} busy={busy} />
      <Button title="Cancel" kind="secondary" onPress={onDone} />
    </Card>
  );
}
