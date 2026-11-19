import { router } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { Button, Card, Field, Screen } from '../../components/ui';
import { createBill } from '../../lib/api';
import { parseNumber, parseUserDate, todayIso, toUserDate } from '../../lib/format';

export default function NewBill() {
  const [vendor, setVendor] = useState('');
  const [billNo, setBillNo] = useState('');
  const [on, setOn] = useState(toUserDate(todayIso()));
  const [amount, setAmount] = useState('');
  const [jobNo, setJobNo] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    const a = parseNumber(amount);
    const d = parseUserDate(on);
    if (!vendor.trim() || !billNo.trim()) return Alert.alert('Enter vendor and bill no.');
    if (a == null) return Alert.alert('Enter the bill amount');
    if (!d) return Alert.alert('Check the date', 'Use the format 31.12.2026');
    setBusy(true);
    try {
      await createBill({ vendor, job_no: jobNo, bill_no: billNo, bill_date: d, amount: a, notes });
      router.back();
    } catch (e: any) { Alert.alert('Could not save', e.message); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <Card>
        <Field label="Vendor (raw material or job work)" value={vendor} onChangeText={setVendor} />
        <Field label="Bill no." value={billNo} onChangeText={setBillNo} />
        <Field label="Bill date" value={on} onChangeText={setOn} placeholder="31.12.2026" />
        <Field label="Amount incl. GST (₹)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
        <Field label="For job no. (optional)" value={jobNo} onChangeText={setJobNo} placeholder="26-1012" autoCapitalize="none" />
        <Field label="Notes" value={notes} onChangeText={setNotes} multiline />
        <Button title="Save bill" onPress={save} busy={busy} />
      </Card>
    </Screen>
  );
}
