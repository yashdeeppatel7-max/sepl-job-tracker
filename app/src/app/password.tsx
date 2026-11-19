import { router } from 'expo-router';
import { useState } from 'react';
import { Button, Card, Field, Screen } from '../components/ui';
import { supabase } from '../lib/supabase';
import { notify } from '../lib/notify';

export default function ChangePassword() {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (pw.length < 8) return notify('Use at least 8 characters');
    if (pw !== pw2) return notify('Passwords do not match');
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return notify('Could not change password', error.message);
    notify('Password changed');
    router.back();
  }
  return (
    <Screen>
      <Card>
        <Field label="New password" value={pw} onChangeText={setPw} secureTextEntry />
        <Field label="Repeat new password" value={pw2} onChangeText={setPw2} secureTextEntry />
        <Button title="Change password" onPress={save} busy={busy} />
      </Card>
    </Screen>
  );
}
