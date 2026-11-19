import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { Button, Card, ErrorBox, Field, Loading, Muted, Pill, Row, Screen, Section } from '../../components/ui';
import { addPayment, getInvoice, updateInvoice } from '../../lib/api';
import { date, money, parseNumber, parseUserDate, todayIso, toUserDate } from '../../lib/format';
import { useQuery } from '../../lib/useQuery';
import { colors } from '../../theme';

export default function InvoiceDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, loading, reload } = useQuery(() => getInvoice(id), [id]);
  const [amount, setAmount] = useState('');
  const [on, setOn] = useState(toUserDate(todayIso()));
  const [ref, setRef] = useState('');
  const [invAmount, setInvAmount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) return <Screen><ErrorBox message={error} /></Screen>;
  if (!data) return <Loading />;
  const { invoice: inv, payments, items } = data;
  const balance = (inv.amount ?? 0) - inv.paid_amount;

  async function pay() {
    const a = parseNumber(amount);
    const d = parseUserDate(on);
    if (!a || a <= 0) return Alert.alert('Enter the amount received');
    if (!d) return Alert.alert('Check the date', 'Use the format 31.12.2026');
    setBusy(true);
    try {
      await addPayment(inv.id, a, d, ref);
      setAmount(''); setRef('');
      await reload();
    } catch (e: any) { Alert.alert('Could not save', e.message); } finally { setBusy(false); }
  }

  async function saveAmount() {
    const a = parseNumber(invAmount ?? '');
    if (a == null) return Alert.alert('Enter a number');
    try { await updateInvoice(inv.id, { amount: a }); setInvAmount(null); reload(); } catch (e: any) { Alert.alert('Could not save', e.message); }
  }

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Stack.Screen options={{ title: `Invoice ${inv.invoice_no}` }} />
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text }}>{inv.customer_code}  ·  {inv.job_no}</Text>
          <Pill label={inv.payment_status === 'paid' ? 'Paid' : inv.payment_status === 'part_paid' ? 'Part paid' : 'Unpaid'} tone={inv.payment_status === 'paid' ? 'good' : inv.payment_status === 'part_paid' ? 'warn' : 'bad'} />
        </View>
        <Row label="Invoice date" value={date(inv.invoice_date)} />
        <Row label="Amount (incl. GST)" value={money(inv.amount)} />
        <Row label="Received" value={money(inv.paid_amount)} />
        <Row label="Balance" value={money(balance)} />
        {invAmount == null
          ? <Text style={{ color: colors.info, fontWeight: '600' }} onPress={() => setInvAmount(inv.amount?.toString() ?? '')}>Edit invoice amount</Text>
          : <>
              <Field label="Invoice amount (incl. GST)" value={invAmount} onChangeText={setInvAmount} keyboardType="decimal-pad" />
              <Button title="Save amount" onPress={saveAmount} />
            </>}
      </Card>

      <Section title="Items on this invoice">
        {items.length === 0 ? <Muted>No items linked.</Muted> : items.map((it) => (
          <Card key={it.line_items.id}>
            <Text style={{ color: colors.text }}>{it.line_items.description}</Text>
            <Muted>Qty {it.qty ?? it.line_items.qty}  ·  {money(it.line_items.line_item_prices?.total_value)}</Muted>
          </Card>
        ))}
      </Section>

      <Section title="Payments">
        {payments.length === 0 ? <Muted>No payments recorded.</Muted> : payments.map((p) => (
          <Card key={p.id}>
            <Row label={date(p.paid_on)} value={money(p.amount)} />
            {p.reference ? <Muted>Ref {p.reference}</Muted> : null}
          </Card>
        ))}
        <Card>
          <Field label="Amount received (₹)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder={balance > 0 ? String(Math.round(balance)) : ''} />
          <Field label="Date" value={on} onChangeText={setOn} placeholder="31.12.2026" />
          <Field label="UTR / cheque no." value={ref} onChangeText={setRef} />
          <Button title="Record payment" onPress={pay} busy={busy} icon="cash-outline" />
        </Card>
      </Section>
    </Screen>
  );
}
