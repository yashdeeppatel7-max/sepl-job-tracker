# SEPL Job & PO Tracker

A mobile app (Android and iPhone) where staff see customer POs and the production stage of every item, limited by role.

| | Items & qty | PO values | Production stages | Invoices, payments, vendor bills | Despatches | Users |
|---|---|---|---|---|---|---|
| Director, CEO | ✅ | ✅ | ✅ update | ✅ | ✅ record | ✅ manage |
| Admin | ✅ | ✅ | ✅ update | ✅ | ✅ record | – |
| Accounts | ✅ | ✅ | view, update invoice/payment stages | ✅ | view status | – |
| Production manager | ✅ | ❌ | ✅ update | ❌ | ❌ | – |
| Production incharge | ✅ | ❌ | ✅ update | ❌ | ❌ | – |

The limits are enforced **in the database** (Postgres row-level security), not only in the app, so a Production manager's phone never receives prices even if someone tampers with the app. Money lives in separate tables (`line_item_prices`, `invoices`, `payments`, `vendor_bills`) that only finance roles can read. Sheet status / sale notes, which often mention amounts, are stored with the prices for the same reason.

## What's in here

```
supabase/
  migrations/0001_schema.sql    tables, stages, role rules, views
  migrations/0002_import.sql    import_po_rows(): saves parsed Excel rows, safe to re-run
  functions/manage-users/       lets Director/CEO add staff accounts (runs on the server)
  tests/run.sh                  36 role-rule checks against plain Postgres
app/                            Expo (React Native) app, Expo Router screens in src/app/
  src/lib/poSheetParser.ts      reads your Google-Sheets PO list (.xlsx)
  scripts/parse-sheet.ts        try the parser on a file from the command line
```

## Process stages

Each item moves through: Raw material ordered → Raw material received → Raw material testing → *TPI witness of RM testing* → Proof machining → Final lathe → Drilling / keyway / other ops → DP / other testing → *Defect rectification* → Grinding / final CNC finish → Balancing / final activity → Dimensional check → *TPI inspection* → Customer approval → Invoice prepared → Despatched → Documents sent → Payment received.

Stages in *italics* only show when the job needs TPI or the item is flagged for rectification. Every production stage can be marked in-house or job work (with vendor name). Enquiry, quotation and PO received are job statuses. Stages are rows in the `stages` table, so adding or renaming one is a one-line change.

**Item cancelled** and **PO cancelled** (`0004_cancel_stages.sql`) can be recorded by Director/CEO/Admin only. PO cancelled on any item cancels every item and sets the job to Cancelled; a job whose remaining items are all despatched counts as Completed.

## Setup (about 30 minutes, once)

### 1. Create the database (free)
1. Sign up at [supabase.com](https://supabase.com) and create a project (region: Mumbai).
2. **SQL Editor** → paste and run `supabase/migrations/0001_schema.sql`, then `0002_import.sql`.
3. **Authentication → Sign In / Providers → Email**: turn **off** "Allow new users to sign up" (only the Director/CEO add people).

### 2. Create the first Director
1. **Authentication → Users → Add user**: your email + a password, tick "Auto confirm".
2. SQL Editor:
   ```sql
   update profiles set role = 'director', full_name = 'Your Name'
   where id = (select id from auth.users where email = 'you@example.com');
   ```

### 3. Deploy the add-user function
With the [Supabase CLI](https://supabase.com/docs/guides/cli): `supabase link --project-ref <ref>` then `supabase functions deploy manage-users`.

### 4. Run the app
```bash
cd app
cp .env.example .env      # paste Project URL and anon key from Supabase → Project Settings → API
npm install
npx expo start            # scan the QR code with a development build or Expo Go
```
To install on staff phones, build with EAS: `npx eas-cli@latest build -p android --profile preview` gives an APK link you can share. For iPhone, use TestFlight (`-p ios`, needs an Apple developer account).

### 5. Import your PO list
In Google Sheets: **File → Download → Microsoft Excel (.xlsx)**. In the app: **More → Import POs from Excel**. Tabs named like `PO-25-26` are imported, others are skipped. You see a preview with any rows to check before saving. Re-importing later updates jobs instead of duplicating them, and keeps stage updates made in the app.

Rules the importer follows:
- Job no. `24/1000` and `24-1000` are treated as the same.
- An item with an invoice number, or status "Complete"/"Done", is marked **Despatched**.
- Several invoices in one cell (`23/051 23/059`) are each recorded; credit notes (`CR-13`) are left in the notes.
- Unreadable dates (`31.11.2024`, `09.09.206`) are left blank and listed in the preview.

## Checks
```bash
# database role rules (needs local Postgres)
PGHOST=/tmp PGPORT=5432 PGUSER=postgres supabase/tests/run.sh
# app
cd app && npx tsc --noEmit
node scripts/parse-sheet.ts path/to/PO_List.xlsx
```

## Notes
- `xlsx` comes from npm at 0.18.5, which has known issues with malicious files. Only Director/CEO/Admin can import, and they import your own sheet, so the risk is low; for production builds switch to the maintained build: `npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`.
- Built on Expo SDK 58 / React Native 0.88.

## Google Sheet auto-sync
The PO Google Sheet can push itself to the app every hour (plus **SEPL App → Sync now** in the sheet).
- `supabase/migrations/0003_sheet_sync.sql`: lets the sync function import; adds `sync_log`.
- `supabase/functions/sync-sheet/`: receives the workbook, parses it with the same parser as the app, imports it. Generated as one file by `node scripts/build-sync-function.mjs` (edit `handler.ts.txt` or the app parser, then rebuild). Needs the `SYNC_SECRET` function secret and "Verify JWT" off.
- `google-sheet/Code.gs`: the Apps Script to paste into the sheet (put the same `SYNC_SECRET` in it).
