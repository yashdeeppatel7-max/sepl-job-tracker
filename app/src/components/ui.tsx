import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, TextInput, View,
  type TextInputProps, type ViewStyle,
} from 'react-native';
import { colors, radius, space } from '../theme';

export function Screen({ children, refreshing, onRefresh, padded = true }: {
  children: ReactNode; refreshing?: boolean; onRefresh?: () => void; padded?: boolean;
}) {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: padded ? space.md : 0, paddingBottom: 48, gap: space.md }}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

export function Card({ children, onPress, style }: { children: ReactNode; onPress?: () => void; style?: ViewStyle }) {
  if (!onPress) return <View style={[s.card, style]}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.card, pressed && { opacity: 0.7 }, style]}>
      {children}
    </Pressable>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={s.title}>{children}</Text>;
}
export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <View style={s.sectionHead}>
        <Text style={s.sectionTitle}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}
export function Muted({ children, style }: { children: ReactNode; style?: object }) {
  return <Text style={[s.muted, style]}>{children}</Text>;
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={s.kv}>
      <Text style={s.kvLabel}>{label}</Text>
      <Text style={s.kvValue}>{value}</Text>
    </View>
  );
}

type Tone = 'neutral' | 'info' | 'good' | 'warn' | 'bad';
const TONES: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: colors.chip, fg: colors.textMuted },
  info: { bg: colors.infoBg, fg: colors.info },
  good: { bg: colors.goodBg, fg: colors.good },
  warn: { bg: colors.warnBg, fg: colors.warn },
  bad: { bg: colors.badBg, fg: colors.bad },
};
export function Pill({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  return (
    <View style={[s.pill, { backgroundColor: TONES[tone].bg }]}>
      <Text style={[s.pillText, { color: TONES[tone].fg }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export function Chips<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.xs }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} style={[s.chip, active && s.chipActive]}>
            <Text style={[s.chipText, active && s.chipTextActive]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function Button({ title, onPress, kind = 'primary', disabled, busy, icon }: {
  title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; busy?: boolean;
  icon?: ComponentProps<typeof Ionicons>['name'];
}) {
  const bg = kind === 'primary' ? colors.primary : kind === 'danger' ? colors.bad : colors.surface;
  const fg = kind === 'secondary' ? colors.primary : '#fff';
  return (
    <Pressable
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [s.button, { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
        kind === 'secondary' && { borderWidth: 1, borderColor: colors.primary }]}
    >
      {busy ? <ActivityIndicator color={fg} /> : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {icon && <Ionicons name={icon} size={18} color={fg} />}
          <Text style={[s.buttonText, { color: fg }]}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput placeholderTextColor={colors.textFaint} style={[s.input, props.multiline && { minHeight: 72, textAlignVertical: 'top' }]} {...props} />
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.toggle}>
      <Text style={s.kvValue}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.primary }} />
    </View>
  );
}

export function Loading() {
  return <View style={{ padding: 40 }}><ActivityIndicator color={colors.primary} /></View>;
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <View style={[s.card, { backgroundColor: colors.badBg, borderColor: colors.bad }]}>
      <Text style={{ color: colors.bad }}>{message}</Text>
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return <Text style={[s.muted, { textAlign: 'center', padding: space.lg }]}>{text}</Text>;
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <View style={s.barTrack}>
      <View style={[s.barFill, { width: `${Math.max(0, Math.min(1, value)) * 100}%` }]} />
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.md, padding: space.md, gap: space.xs, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 },
  muted: { color: colors.textMuted, fontSize: 13 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, paddingVertical: 3 },
  kvLabel: { color: colors.textMuted, fontSize: 14 },
  kvValue: { color: colors.text, fontSize: 14, fontWeight: '500', flexShrink: 1, textAlign: 'right' },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, alignSelf: 'flex-start' },
  pillText: { fontSize: 12, fontWeight: '600' },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.text, fontSize: 13, fontWeight: '500' },
  chipTextActive: { color: '#fff' },
  button: { height: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.md },
  buttonText: { fontSize: 15, fontWeight: '600' },
  fieldLabel: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: colors.text },
  hint: { fontSize: 12, color: colors.textFaint },
  toggle: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: colors.chip, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3, backgroundColor: colors.good },
});
