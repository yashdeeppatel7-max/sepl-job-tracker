import { Ionicons } from '@expo/vector-icons';
import { router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { Card, Chips, Empty, ErrorBox, Loading, Muted, Pill } from '../../components/ui';
import { invoiceBalance, invoicePill, listBills, listInvoices, markBillPaid, type InvoiceRow, type VendorBill } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, money, moneyShort } from '../../lib/format';
import { useQuery } from '../../lib/useQuery';
import { colors, space } from '../../theme';
import { notify } from '../../lib/notify';

type View_ = 'unpaid' | 'paid' | 'all' | 'bills';

export default function Finance() {
  const { perms } = useAuth();
  const [view, setView] = useState<View_>('unpaid');
  const [q, setQ] = useState('');
  const { data, error, loading, reload } = useQuery(async () => {
    const [invoices, bills] = await Promise.all([listInvoices(), listBills()]);
    return { invoices, bills };
  });

  const totals = useMemo(() => {
    const inv = data?.invoices ?? [];
    const outstanding = inv.reduce((s, i) => s + invoiceBalance(i), 0);
    const billsDue = (data?.bills ?? []).filter((b) => !b.paid).reduce((s, b) => s + b.amount, 0);
    return { outstanding, billsDue };
  }, [data]);

  const term = q.trim().toLowerCase();
  const invoices = (data?.invoices ?? []).filter((i) =>
    (view === 'all' || (view === 'paid' ? i.payment_status === 'paid' : i.payment_status !== 'paid')) &&
    (!term || [i.invoice_no, i.job_no, i.customer_code].some((v) => v?.toLowerCase().includes(term))));
  const bills = (data?.bills ?? []).filter((b) => !term || [b.bill_no, b.vendors?.name, b.jobs?.job_no].some((v) => v?.toLowerCase().includes(term)));

  if (!perms.seeMoney) return <Empty text="Finance is not available for your role." />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{
        headerRight: () => (
          <Pressable onPress={() => router.push('/bill/new')} style={{ paddingHorizontal: 16 }} accessibilityLabel="New vendor bill">
            <Ionicons name="add" size={26} color="#fff" />
          </Pressable>
        ),
      }} />
      <View style={{ padding: space.md, gap: space.sm }}>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Stat label="To receive from customers" value={moneyShort(totals.outstanding)} />
          <Stat label="To pay vendors" value={moneyShort(totals.billsDue)} />
        </View>
        <TextInput value={q} onChangeText={setQ} placeholder="Search invoice, job, customer, vendor" placeholderTextColor={colors.textFaint} style={styles.search} />
        <Chips<View_> value={view} onChange={setView} options={[
          { value: 'unpaid', label: 'Unpaid invoices' }, { value: 'paid', label: 'Paid' }, { value: 'all', label: 'All invoices' }, { value: 'bills', label: 'Vendor bills' },
        ]} />
      </View>
      {error && <View style={{ paddingHorizontal: space.md }}><ErrorBox message={error} /></View>}
      {loading && !data ? <Loading /> : view === 'bills' ? (
        <FlatList data={bills} keyExtractor={(b) => b.id}
          contentContainerStyle={{ padding: space.md, paddingTop: 0, gap: space.sm }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
          ListEmptyComponent={<Empty text="No vendor bills yet. Tap + to add one." />}
          renderItem={({ item }) => <BillCard bill={item} onChange={reload} />} />
      ) : (
        <FlatList data={invoices} keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: space.md, paddingTop: 0, gap: space.sm }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} />}
          ListEmptyComponent={<Empty text="No invoices here." />}
          renderItem={({ item }) => <InvoiceCard inv={item} />} />
      )}
    </View>
  );
}

function InvoiceCard({ inv }: { inv: InvoiceRow }) {
  const pill = invoicePill(inv);
  return (
    <Card onPress={() => router.push(`/invoice/${inv.id}`)}>
      <View style={styles.head}>
        <Text style={styles.strong}>{inv.is_credit_note ? 'Credit note' : 'Inv'} {inv.invoice_no}</Text>
        <Pill label={pill.label} tone={pill.tone} />
      </View>
      <Muted>{inv.customer_code}  ·  Job {inv.job_no}  ·  {date(inv.invoice_date)}</Muted>
      <View style={styles.head}>
        <Muted>Received {money(inv.paid_amount)}{inv.credited_amount > 0 ? `  ·  credit notes ${money(inv.credited_amount)}` : ''}</Muted>
        <Text style={styles.amount}>{inv.amount == null ? 'Amount not set' : money(inv.amount)}</Text>
      </View>
    </Card>
  );
}

function BillCard({ bill, onChange }: { bill: VendorBill; onChange: () => void }) {
  return (
    <Card>
      <View style={styles.head}>
        <Text style={styles.strong}>{bill.vendors?.name ?? 'Vendor'}</Text>
        <Pill label={bill.paid ? `Paid ${date(bill.paid_on)}` : 'Unpaid'} tone={bill.paid ? 'good' : 'bad'} />
      </View>
      <Muted>Bill {bill.bill_no}  ·  {date(bill.bill_date)}{bill.jobs ? `  ·  Job ${bill.jobs.job_no}` : ''}</Muted>
      {bill.notes ? <Muted>{bill.notes}</Muted> : null}
      <View style={styles.head}>
        <Text style={{ color: colors.info, fontWeight: '600' }} onPress={async () => {
          try { await markBillPaid(bill.id, !bill.paid); onChange(); } catch (e: any) { notify('Could not save', e.message); }
        }}>{bill.paid ? 'Mark unpaid' : 'Mark paid'}</Text>
        <Text style={styles.amount}>{money(bill.amount)}</Text>
      </View>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text }}>{value}</Text>
      <Text style={{ fontSize: 12, color: colors.textMuted }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stat: { flex: 1, backgroundColor: colors.surface, borderRadius: 12, padding: space.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  search: { backgroundColor: colors.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: colors.border, fontSize: 15, color: colors.text },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  strong: { fontSize: 16, fontWeight: '700', color: colors.text },
  amount: { fontSize: 15, fontWeight: '700', color: colors.primary },
});
