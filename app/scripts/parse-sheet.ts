// Usage: node scripts/parse-sheet.ts <file.xlsx> [--json out.json]
// Checks how the PO workbook will be imported, without touching the database.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseWorkbook, readWorkbook, toDbRows } from '../src/lib/poSheetParser.ts';

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/parse-sheet.ts <file.xlsx> [--json out.json]'); process.exit(1); }
const wb = readWorkbook(new Uint8Array(readFileSync(file)), 'array');
const res = parseWorkbook(wb);
console.table(res.sheets);
const jobs = new Set(res.rows.map((r) => r.job_no));
console.log(`Rows: ${res.rows.length}  Jobs: ${jobs.size}  Invoices: ${new Set(res.rows.flatMap((r) => r.invoices.map((i) => i.no))).size}`);
const byLevel = (l: string) => res.issues.filter((i) => i.level === l);
console.log(`Errors: ${byLevel('error').length}  Warnings: ${byLevel('warning').length}`);
for (const i of res.issues.slice(0, 60)) console.log(`  [${i.level}] ${i.sheet} row ${i.row}: ${i.message}`);
const j = process.argv.indexOf('--json');
if (j > 0) writeFileSync(process.argv[j + 1], JSON.stringify(toDbRows(res.rows)));
