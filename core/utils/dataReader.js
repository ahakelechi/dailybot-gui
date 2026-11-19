// core/utils/dataReader.js
//
// Instead of editing code every morning, the daily entries live in Excel
// (or are edited via the GUI's Entries page, which writes to the same
// file). This module reads data/dailyLog.xlsx and hands forms.js a clean
// array of plain objects.

const ExcelJS = require("exceljs");
const fs = require("fs");
const config = require("../config");
const logger = require("./logger");
const { formatDateOnly } = require("./helpers");

// ---------------------------------------------------------------------
// Write safety
//
// Every change to the data file is a read-modify-write: load the whole
// workbook, change it in memory, write the whole thing back. Two of those
// running at the same moment (a quick double-click on Add, several Remove
// clicks in a row, or a run finishing while entries are being edited) both
// start from the same snapshot, so one edit silently overwrites the other --
// and when the two writes overlap in time their bytes interleave and the
// .xlsx can't be opened at all ("Corrupted zip or bug: expected N records
// in central dir"), which takes down the Daily Entries tab, Add Entry and
// Run Now until the file is rebuilt.
//
// So edits go through a queue that runs them strictly one at a time, and
// every write goes to a temp file that is then renamed over the real one:
// a failed or interrupted save can never leave a half-written spreadsheet.
// ---------------------------------------------------------------------
let editQueue = Promise.resolve();

/**
 * Run `task` after every edit queued before it has finished (whether or not
 * those succeeded). Tasks must NOT call another locked function -- they
 * would wait on themselves forever; use the *Unlocked helpers instead.
 */
function withDataFileLock(task) {
  const result = editQueue.then(task);
  editQueue = result.catch(() => {}); // one failed edit must not block the ones behind it
  return result;
}

async function writeWorkbookAtomically(workbook, filePath) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await workbook.xlsx.writeFile(tempPath);
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    if (err.code === "EPERM" || err.code === "EBUSY") {
      throw new Error(
        `Could not save ${filePath} -- it looks like it's open in another program (Excel?). ` +
          "Close it and try again."
      );
    }
    throw err;
  }
}

/**
 * Normalize a raw "Date" cell value into a YYYY-MM-DD string. Handles
 * exceljs giving back a real JS Date (typical for a cell formatted as a
 * date), a plain string someone typed in, or nothing at all -- in which
 * case it defaults to today, so existing sheets with no Date column keep
 * working exactly as before.
 *
 * @param {*} rawValue
 * @returns {string} YYYY-MM-DD
 */
function normalizeDate(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return formatDateOnly(new Date());
  }
  if (rawValue instanceof Date) {
    return formatDateOnly(rawValue);
  }
  const parsed = new Date(rawValue);
  if (!Number.isNaN(parsed.getTime())) {
    return formatDateOnly(parsed);
  }
  logger.warning(`Could not parse Date value "${rawValue}" -- defaulting that row to today.`);
  return formatDateOnly(new Date());
}

/**
 * Read daily-log entries from an Excel file.
 *
 * Expected columns (header row): Date, Partner, Calls, Meetings, Blockers,
 * Priority, Notes. Date is optional per row -- leave it blank to mean
 * "today". Multiple rows can share the same Date to log several visits
 * in one day; each row is one visit.
 *
 * @param {string} [filePath] - defaults to config.paths.dataFile.
 * @returns {Promise<Array<Object>>} one object per data row, each with a
 *   normalized `Date` field (YYYY-MM-DD) alongside the original columns.
 */
async function readDailyLogEntries(filePath = config.paths.dataFile) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Data file not found: ${filePath}. Add an Excel file with columns ` +
        `Date, Partner, Calls, Meetings, Blockers, Priority, Notes, Latitude, Longitude ` +
        `(Latitude/Longitude are optional -- blank means "use the default location").`
    );
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error(`No worksheet found in ${filePath}`);
  }

  const headerRow = sheet.getRow(1);
  const headers = [];
  headerRow.eachCell((cell, colNumber) => {
    headers[colNumber] = String(cell.value || "").trim();
  });

  const entries = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip header

    const entry = {};
    let hasData = false;

    row.eachCell((cell, colNumber) => {
      const key = headers[colNumber];
      if (!key) return;
      const value = cell.value === null || cell.value === undefined ? "" : cell.value;
      entry[key] = value;
      if (value !== "") hasData = true;
    });

    if (hasData) {
      entry.Date = normalizeDate(entry.Date);
      // Tracks exactly which physical spreadsheet row this entry came
      // from, so a later successful submission can remove precisely this
      // row (see removeRows below) even if another row shares the same
      // Date/Partner. Double-underscore keeps it from ever colliding with
      // a real column header.
      entry.__rowNumber = rowNumber;
      entries.push(entry);
    }
  });

  logger.info(`Loaded ${entries.length} entr${entries.length === 1 ? "y" : "ies"} from ${filePath}`);
  return entries;
}

/**
 * Remove specific rows from the data file once their entries have been
 * successfully submitted, so a future run (especially after a mid-run
 * crash) never resubmits the same visit twice against the real site.
 *
 * @param {Array<number>} rowNumbers - 1-indexed spreadsheet row numbers to remove.
 * @param {string} [filePath] - defaults to config.paths.dataFile.
 */
async function removeRows(rowNumbers, filePath = config.paths.dataFile) {
  if (!rowNumbers || rowNumbers.length === 0) return;

  return withDataFileLock(async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const sheet = workbook.worksheets[0];
    if (!sheet) return;

    // Descending order: removing a row shifts every row below it up by one,
    // so working from the bottom up means each remaining target row number
    // is still valid when its turn comes.
    const sorted = [...new Set(rowNumbers)].sort((a, b) => b - a);
    for (const rowNumber of sorted) {
      sheet.spliceRows(rowNumber, 1);
    }

    await writeWorkbookAtomically(workbook, filePath);
  });
}

/**
 * Append one entry row (the Entries tab's Add Entry). Creates the file if
 * it doesn't exist yet and adds the Latitude/Longitude columns if it
 * predates them, all inside a single locked read-modify-write.
 *
 * @param {Array} rowValues - Date, Partner, Calls, Meetings, Blockers,
 *   Priority, Notes, Latitude, Longitude (same order as the header row).
 * @param {string} [filePath] - defaults to config.paths.dataFile.
 */
async function appendEntryRow(rowValues, filePath = config.paths.dataFile) {
  return withDataFileLock(async () => {
    await ensureDataFileUnlocked(filePath);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error(`No worksheet found in ${filePath}`);

    // Older data files (created before location overrides existed) won't
    // have these columns yet -- add them before appending a row that
    // assumes they're there.
    addMissingLocationHeaders(sheet);

    sheet.addRow(rowValues);
    await writeWorkbookAtomically(workbook, filePath);
  });
}

/**
 * Group a flat list of entries (each with a normalized `Date` field) into
 * one array per date, in date order. This is what lets index.js open the
 * "Log My Day" form once per distinct date -- including past, missed
 * dates -- instead of assuming everything is for today.
 *
 * @param {Array<Object>} entries
 * @returns {Array<{date: string, entries: Array<Object>}>} sorted by date ascending.
 */
function groupEntriesByDate(entries) {
  const byDate = new Map();
  for (const entry of entries) {
    const list = byDate.get(entry.Date) || [];
    list.push(entry);
    byDate.set(entry.Date, list);
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, dateEntries]) => ({ date, entries: dateEntries }));
}

/**
 * Ensure a data file exists with the expected header row -- used on
 * first run so the GUI always has something valid to read/write.
 *
 * @param {string} [filePath]
 */
async function ensureDataFile(filePath = config.paths.dataFile) {
  return withDataFileLock(() => ensureDataFileUnlocked(filePath));
}

async function ensureDataFileUnlocked(filePath) {
  if (fs.existsSync(filePath)) return;

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Daily Log");
  sheet.addRow(["Date", "Partner", "Calls", "Meetings", "Blockers", "Priority", "Notes", "Latitude", "Longitude"]);
  await writeWorkbookAtomically(workbook, filePath);
  logger.info(`Created a fresh data file at ${filePath}`);
}

/**
 * Add "Latitude"/"Longitude" columns to the header row if a data file was
 * created before those existed. Idempotent -- safe to call before every
 * append. Existing rows are untouched (their new cells just read as
 * blank, which already means "use the default location").
 *
 * @param {string} [filePath]
 */
async function ensureLocationColumns(filePath = config.paths.dataFile) {
  return withDataFileLock(async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    if (!sheet) return;

    if (addMissingLocationHeaders(sheet)) {
      await writeWorkbookAtomically(workbook, filePath);
    }
  });
}

/**
 * Add "Latitude"/"Longitude" to the header row of an already-loaded sheet
 * if they're missing. Pure in-memory; the caller decides whether to save.
 *
 * @param {import('exceljs').Worksheet} sheet
 * @returns {boolean} true if anything was added.
 */
function addMissingLocationHeaders(sheet) {
  const headerRow = sheet.getRow(1);
  const headerNames = [];
  headerRow.eachCell((cell) => headerNames.push(String(cell.value || "").trim()));

  let nextCol = headerRow.cellCount + 1;
  let changed = false;
  if (!headerNames.includes("Latitude")) {
    headerRow.getCell(nextCol).value = "Latitude";
    nextCol += 1;
    changed = true;
  }
  if (!headerNames.includes("Longitude")) {
    headerRow.getCell(nextCol).value = "Longitude";
    changed = true;
  }
  return changed;
}

module.exports = {
  readDailyLogEntries,
  groupEntriesByDate,
  removeRows,
  appendEntryRow,
  ensureDataFile,
  ensureLocationColumns,
};
