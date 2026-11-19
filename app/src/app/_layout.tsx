import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../lib/auth';
import { colors } from '../theme';
import { Loading } from '../components/ui';
import { View } from 'react-native';

function RootStack() {
  const { loading, session } = useAuth();
  if (loading) return <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg }}><Loading /></View>;
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Protected guard={!session}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="job/[id]" options={{ title: 'Job' }} />
        <Stack.Screen name="job/new" options={{ title: 'New job' }} />
        <Stack.Screen name="item/[id]" options={{ title: 'Item' }} />
        <Stack.Screen name="invoice/[id]" options={{ title: 'Invoice' }} />
        <Stack.Screen name="invoice/new" options={{ title: 'New invoice' }} />
        <Stack.Screen name="despatch/new" options={{ title: 'Record despatch' }} />
        <Stack.Screen name="bill/new" options={{ title: 'New vendor bill' }} />
        <Stack.Screen name="users" options={{ title: 'Users & roles' }} />
        <Stack.Screen name="import" options={{ title: 'Import from Excel' }} />
        <Stack.Screen name="password" options={{ title: 'Change password' }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <RootStack />
    </AuthProvider>
  );
}
