import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { Button, ErrorBox, Field } from '../components/ui';
import { isConfigured, supabase } from '../lib/supabase';
import { colors, space } from '../theme';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wrap}>
      <View style={styles.brand}>
        <Text style={styles.logo}>SEPL</Text>
        <Text style={styles.tag}>Job & PO tracker</Text>
      </View>
      <View style={styles.form}>
        {!isConfigured && <ErrorBox message="App is not connected to a database yet. Add the Supabase URL and key to app/.env (see README)." />}
        <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" placeholder="you@company.com" />
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" placeholder="••••••••" onSubmitEditing={signIn} />
        {error && <ErrorBox message={error} />}
        <Button title="Sign in" onPress={signIn} busy={busy} disabled={!email || !password} />
        <Text style={styles.help}>Accounts are created by the Director or CEO. Ask them if you can't sign in.</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.primary, justifyContent: 'center', padding: space.lg, gap: space.lg },
  brand: { alignItems: 'center', gap: 4 },
  logo: { color: '#fff', fontSize: 40, fontWeight: '800', letterSpacing: 4 },
  tag: { color: '#C9D6E8', fontSize: 15 },
  form: { backgroundColor: colors.bg, borderRadius: 16, padding: space.md, gap: space.md },
  help: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },
});
