import { router } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { Button, Card, Field, Screen } from '../components/ui';
import { supabase } from '../lib/supabase';

export default function ChangePassword() {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (pw.length < 8) return Alert.alert('Use at least 8 characters');
    if (pw !== pw2) return Alert.alert('Passwords do not match');
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return Alert.alert('Could not change password', error.message);
    Alert.alert('Password changed');
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
