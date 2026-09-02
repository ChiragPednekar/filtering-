/**
 * Real-time Google Sheets -> Supabase sync.
 *
 * Paste this into the sheet's Apps Script editor and install the trigger (see the
 * setup steps in README.md). After that, every edit to the sheet pings Supabase and
 * the database catches up within seconds.
 *
 * A pg_cron job also syncs every 15 minutes, so the data stays correct even if this
 * script is removed, unauthorised, or Google is having a bad day.
 */

// ---------------------------------------------------------------------------
// Configuration — set SYNC_SECRET once via the setup helper below, not here.
// ---------------------------------------------------------------------------
var FUNCTION_URL = 'https://akqhuzgekjsvrizysfmp.supabase.co/functions/v1/sync-sheet';

/**
 * Run this ONCE from the Apps Script editor, after pasting your secret between the
 * quotes. It stores the secret in this script's private properties so the value is
 * not sitting in the source, then blanks itself out of your clipboard's way.
 *
 * Replace PASTE_SECRET_HERE, press Run, then delete the secret from this line again.
 */
function setUpSecret() {
  var secret = 'PASTE_SECRET_HERE';
  if (secret === 'PASTE_SECRET_HERE' || !secret) {
    throw new Error('Edit setUpSecret() and put your SYNC_SECRET in the quotes first.');
  }
  PropertiesService.getScriptProperties().setProperty('SYNC_SECRET', secret);
  Logger.log('Secret stored. You can clear it from the code now.');
}

/**
 * Edits arrive in bursts — a paste, a fill-down, someone tabbing across a row. Firing
 * a sync per keystroke would hammer the function, so this records that a change
 * happened and lets a short debounce window collapse the burst into one run.
 */
function onSheetChange(e) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('DIRTY_AT', String(Date.now()));
  scheduleFlush_();
}

function scheduleFlush_() {
  // One pending flush at a time.
  var existing = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'flushSync';
  });
  if (existing.length) return;

  ScriptApp.newTrigger('flushSync')
    .timeBased()
    .after(15 * 1000) // 15s debounce: long enough to swallow a burst of edits
    .create();
}

/** Fires the sync, then removes its own one-shot trigger. */
function flushSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'flushSync') ScriptApp.deleteTrigger(t);
  });

  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SYNC_SECRET');
  if (!secret) {
    Logger.log('No SYNC_SECRET stored. Run setUpSecret() first.');
    return;
  }

  // If more edits landed while we waited, the debounce window restarts instead of
  // syncing a half-finished change.
  var dirtyAt = Number(props.getProperty('DIRTY_AT') || 0);
  if (Date.now() - dirtyAt < 10 * 1000) {
    scheduleFlush_();
    return;
  }

  var res = UrlFetchApp.fetch(FUNCTION_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-sync-secret': secret },
    payload: JSON.stringify({ trigger: 'sheet-edit' }),
    muteHttpExceptions: true,
  });

  var code = res.getResponseCode();
  Logger.log('sync-sheet -> HTTP ' + code + ' ' + res.getContentText().slice(0, 400));
  props.setProperty('LAST_SYNC_CODE', String(code));
  props.setProperty('LAST_SYNC_AT', new Date().toISOString());
}

/** Run once to install the onChange trigger. Safe to run again; it de-duplicates. */
function installTrigger() {
  var already = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'onSheetChange';
  });
  if (already) {
    Logger.log('onChange trigger already installed.');
    return;
  }
  ScriptApp.newTrigger('onSheetChange')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onChange()
    .create();
  Logger.log('Installed. Edits will now sync within about 15 seconds.');
}

/** Fires a sync immediately, ignoring the debounce. Handy for testing. */
function syncNow() {
  PropertiesService.getScriptProperties().setProperty('DIRTY_AT', '0');
  flushSync();
}
