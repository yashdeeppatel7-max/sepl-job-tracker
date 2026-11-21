/**
 * SEPL Job Tracker: Google Sheet → app sync.
 * Paste into the PO sheet: Extensions → Apps Script. Then run "setup" once.
 * Adds a "SEPL App" menu with "Sync now", and syncs automatically every hour.
 */
const SYNC_URL = 'https://xcdaaxbjvjljqfzparoj.supabase.co/functions/v1/sync-sheet';
const PUBLISHABLE_KEY = 'sb_publishable_xZlBNUOBN6CAmieZUytksA_5vdDzmvZ';
const SYNC_SECRET = '__SYNC_SECRET__';   // must match the SYNC_SECRET set in Supabase

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('SEPL App')
    .addItem('Sync now', 'syncNow')
    .addItem('Turn on hourly sync', 'setup')
    .addToUi();
}

/** Run once: asks for permission and turns on the hourly sync. */
function setup() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncToApp')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncToApp').timeBased().everyHours(1).create();
  const result = syncToApp();
  try { SpreadsheetApp.getUi().alert('Hourly sync is on.\n\n' + result); } catch (e) { Logger.log(result); }
}

/** Menu item: sync immediately and show the result. */
function syncNow() {
  const result = syncToApp();
  SpreadsheetApp.getUi().alert(result);
}

/** Sends the whole workbook (as .xlsx) to the app. Returns a short summary. */
function syncToApp() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  DriveApp.getFileById(ss.getId()); // needed so Google grants read access to export the file
  const exportUrl = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx';
  const file = UrlFetchApp.fetch(exportUrl, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  if (file.getResponseCode() !== 200) return 'Could not export the sheet (' + file.getResponseCode() + ').';

  const res = UrlFetchApp.fetch(SYNC_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-sync-secret': SYNC_SECRET, apikey: PUBLISHABLE_KEY },
    payload: JSON.stringify({ xlsx_base64: Utilities.base64Encode(file.getBlob().getBytes()) }),
    muteHttpExceptions: true,
  });
  let body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) { body = { error: res.getContentText().slice(0, 200) }; }
  if (res.getResponseCode() !== 200) return 'Sync failed: ' + (body.error || res.getResponseCode());
  const msg = 'Synced ' + body.rows + ' items. New jobs: ' + body.jobs_new + ', updated jobs: ' + body.jobs_updated +
    ', new invoices: ' + body.invoices_new + (body.warnings ? '. Rows to check: ' + body.warnings : '.');
  Logger.log(msg);
  return msg;
}
