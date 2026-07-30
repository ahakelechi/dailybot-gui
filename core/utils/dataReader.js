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
        `Date, Partner, Calls, Meetings, Blockers, Priority, Notes.`
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

  await workbook.xlsx.writeFile(filePath);
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
  if (fs.existsSync(filePath)) return;

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Daily Log");
  sheet.addRow(["Date", "Partner", "Calls", "Meetings", "Blockers", "Priority", "Notes"]);
  await workbook.xlsx.writeFile(filePath);
  logger.info(`Created a fresh data file at ${filePath}`);
}

module.exports = { readDailyLogEntries, groupEntriesByDate, removeRows, ensureDataFile };
