import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router/tabs';
import { useAuth } from '../../lib/auth';
import { colors } from '../../theme';

export default function TabsLayout() {
  const { perms } = useAuth();
  const icon = (name: keyof typeof Ionicons.glyphMap) => ({ color, size }: { color: unknown; size: number }) =>
    <Ionicons name={name} color={color as string} size={size} />;
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: '#fff',
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textFaint,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Jobs', tabBarIcon: icon('construct-outline') }} />
      <Tabs.Screen name="finance" options={{ title: 'Finance', tabBarIcon: icon('wallet-outline'), href: perms.seeMoney ? undefined : null }} />
      <Tabs.Screen name="despatch" options={{ title: 'Despatch', tabBarIcon: icon('car-outline'), href: perms.seeDespatch ? undefined : null }} />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: icon('person-circle-outline') }} />
    </Tabs>
  );
}
