import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useState } from 'react';
import { Alert, Platform, Text, View } from 'react-native';
import { Button, Card, Empty, ErrorBox, Muted, Pill, Row, Screen, Section } from '../components/ui';
import { importRows } from '../lib/api';
import { useAuth } from '../lib/auth';
import { parseWorkbook, readWorkbook, toDbRows, type ParseResult } from '../lib/poSheetParser';
import { colors } from '../theme';

const BATCH = 300; // rows per request; keeps each call small on mobile data

export default function Import() {
  const { perms } = useAuth();
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!perms.importExcel) return <Empty text="Only Director, CEO or Admin can import." />;

  async function pick() {
    setError(null); setResult(null); setParsed(null);
    const res = await DocumentPicker.getDocumentAsync({
      type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'],
      copyToCacheDirectory: true,
    });
    if (res.canceled) return;
    const asset = res.assets[0];
    setFileName(asset.name);
    setBusy(true);
    try {
      const b64 = Platform.OS === 'web' && asset.base64
        ? asset.base64.replace(/^data:.*;base64,/, '')
        : await new File(asset.uri).base64();
      // let the spinner render before the (synchronous) parse
      await new Promise((r) => setTimeout(r, 50));
      setParsed(parseWorkbook(readWorkbook(b64, 'base64')));
    } catch (e: any) {
      setError(`Could not read this file: ${e.message}`);
    } finally { setBusy(false); }
  }

  async function run() {
    if (!parsed) return;
    setBusy(true); setError(null);
    const totals: Record<string, number> = {};
    try {
      // keep all rows of a job in the same batch
      const rows = toDbRows(parsed.rows);
      const batches: typeof rows[] = [];
      let cur: typeof rows = [];
      for (let i = 0; i < rows.length; i++) {
        cur.push(rows[i]);
        const nextIsNewJob = i + 1 >= rows.length || rows[i + 1].job_no !== rows[i].job_no;
        if (cur.length >= BATCH && nextIsNewJob) { batches.push(cur); cur = []; }
      }
      if (cur.length) batches.push(cur);
      for (let b = 0; b < batches.length; b++) {
        setProgress(`Saving part ${b + 1} of ${batches.length}…`);
        const r = await importRows(batches[b]);
        for (const [k, v] of Object.entries(r)) totals[k] = (totals[k] ?? 0) + v;
      }
      setResult(totals);
    } catch (e: any) {
      setError(`Import stopped: ${e.message}. Parts already saved are kept; running the import again is safe.`);
    } finally { setBusy(false); setProgress(null); }
  }

  const warnings = parsed?.issues ?? [];
  return (
    <Screen>
      <Card>
        <Text style={{ fontSize: 15, color: colors.text }}>
          Pick your PO list (.xlsx). In Google Sheets use File → Download → Microsoft Excel. Tabs named like PO-25-26 are imported; other tabs are skipped.
        </Text>
        <Muted>Running it again later updates existing jobs instead of duplicating them. Stage updates made in the app are kept.</Muted>
        <Button title={fileName ? 'Pick a different file' : 'Pick Excel file'} kind={parsed ? 'secondary' : 'primary'} icon="document-outline" onPress={pick} busy={busy && !parsed} />
      </Card>
      {error && <ErrorBox message={error} />}
      {parsed && (
        <>
          <Section title={`Preview: ${fileName}`}>
            <Card>
              {parsed.sheets.map((s) => (
                <Row key={s.name} label={s.name} value={s.skipped ? 'skipped' : `${s.jobs} jobs, ${s.rows} items`} />
              ))}
              <Row label="Total" value={`${new Set(parsed.rows.map((r) => r.job_no)).size} jobs, ${parsed.rows.length} items`} />
            </Card>
          </Section>
          {warnings.length > 0 && (
            <Section title={`Rows to check (${warnings.length})`}>
              <Card>
                {warnings.slice(0, 50).map((w, i) => (
                  <View key={i} style={{ flexDirection: 'row', gap: 8, paddingVertical: 3 }}>
                    <Pill label={w.level === 'error' ? 'Error' : 'Check'} tone={w.level === 'error' ? 'bad' : 'warn'} />
                    <Text style={{ flex: 1, color: colors.text, fontSize: 13 }}>{w.sheet} row {w.row}: {w.message}</Text>
                  </View>
                ))}
                {warnings.length > 50 && <Muted>…and {warnings.length - 50} more</Muted>}
                <Muted>These rows still import; the unclear value is left blank so you can fix it in the sheet or the app.</Muted>
              </Card>
            </Section>
          )}
          {!result && <Button title={`Import ${parsed.rows.length} items`} onPress={run} busy={busy} disabled={!parsed.rows.length} icon="cloud-upload-outline" />}
          {progress && <Muted style={{ textAlign: 'center' }}>{progress}</Muted>}
        </>
      )}
      {result && (
        <Card style={{ borderColor: colors.good }}>
          <Text style={{ fontWeight: '700', color: colors.good, fontSize: 16 }}>Import finished</Text>
          <Row label="New jobs" value={result.jobs_new} />
          <Row label="Updated jobs" value={result.jobs_updated} />
          <Row label="New items" value={result.items_new} />
          <Row label="Updated items" value={result.items_updated} />
          <Row label="New invoices" value={result.invoices_new} />
        </Card>
      )}
    </Screen>
  );
}
