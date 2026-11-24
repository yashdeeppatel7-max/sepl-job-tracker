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
  tests/run.sh                  45 role-rule checks against plain Postgres
app/                            Expo (React Native) app, Expo Router screens in src/app/
  src/lib/poSheetParser.ts      reads your Google-Sheets PO list (.xlsx)
  scripts/parse-sheet.ts        try the parser on a file from the command line
```

## Process stages

Each item moves through: Pattern started → Pattern sent to casting → Raw material ordered → Raw material received → Raw material testing → *TPI witness of RM testing* → Proof machining → Final lathe → Drilling / keyway / other ops → DP / other testing → *Defect rectification* → Grinding / final CNC finish → Balancing / final activity → Dimensional check → *TPI inspection* → Customer approval → Invoice prepared → Despatched → Documents sent → Payment received.

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

## Automatic database changes
`.github/workflows/db-migrate.yml` applies any new or changed file in `supabase/migrations/` to Supabase when it is pushed to `main` (each file in one transaction; files are written to be safe to run again). It can also re-apply one file from **Actions → Apply database changes → Run workflow**. One-time setup: add the repository secret `SUPABASE_DB_URL` = Supabase **Connect → Session pooler** connection string with the database password filled in.

## Database backup
`.github/workflows/db-backup.yml` backs up the Supabase database every Monday at 3:00 AM India time (the free plan has no downloadable backups). It can also be run any time from **Actions → Weekly database backup → Run workflow**.

- Because this repository is public, each backup is a `.7z` file locked with AES-256 using the `BACKUP_PASSWORD` repository secret (20+ characters; keep a copy somewhere safe, since GitHub never shows it again). Nothing about the data is printed in the log.
- Find backups under the run's **Artifacts**. GitHub keeps each for 90 days (about 13 weekly copies). Download one now and then to keep it longer.
- Inside: `app.dump` (all app tables, data and access rules), `logins.sql` (staff logins), `login-triggers.sql`, and `RESTORE.txt` with the restore commands. Open it with 7-Zip (Windows) or Keka (Mac) and the password.
- One-time setup: add the repository secret `BACKUP_PASSWORD` (`SUPABASE_DB_URL` is already used by the migrations workflow).

## WhatsApp summaries

`.github/workflows/whatsapp-summary.yml` sends two WhatsApp messages through
[Green API](https://green-api.com/en) (free Developer plan: up to 3 chats), from a WhatsApp number
linked in the Green API console like WhatsApp Web. [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/)
is a fallback when `GREEN_API` is not set.

- **Daily**, Mon–Sat about 8:00 AM India time, to the Director and the CEO: work moved, despatches,
  invoices and payments since the last report (Monday covers Sat + Sun), plus overdue POs,
  POs due in 7 days and POs with no update for 10+ days.
- **Weekly**, Mondays about 8:15 AM, to the Director only: money customers owe (by age, past due date,
  by customer, oldest), payments received in the last 7 days, and unpaid supplier bills.

Queries: `summaries/daily.sql`, `summaries/weekly.sql` (read-only). Message text: `summaries/send.mjs`.
Secrets: `GREEN_API` = "apiUrl idInstance apiTokenInstance" from the Green API console;
`WA_DIRECTOR` and `WA_CEO` = WhatsApp numbers with country code, e.g. `+91 98250 12345`
(for CallMeBot, add a space and that person's CallMeBot key).
Test locally with `DRY_RUN=true node summaries/send.mjs daily data.json`.
