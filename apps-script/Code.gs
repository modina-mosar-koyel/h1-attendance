/**
 * Hasan Enterprise - Attendance & Overtime backend (Google Apps Script)
 *
 * Deploy as a Web App (Execute as: Me, Who has access: Anyone) and paste
 * the resulting URL into APPS_SCRIPT_URL in app.js. See README for the
 * full step-by-step.
 *
 * Sheets created automatically on first run, inside a spreadsheet named
 * "Hasan Enterprise - Attendance & Overtime Log":
 *   - "Log"            one row per employee per day (the main log)
 *   - "Employees"      registered employees + their reference photo
 *   - "SyncLog"        internal - prevents duplicate scans being re-applied
 *   - "Monthly Summary" auto-recomputed after every sync
 */

const SPREADSHEET_NAME = "Hasan Enterprise - Attendance & Overtime Log";
const PHOTO_FOLDER_NAME = "Hasan Enterprise Face Photos";

const LOG_HEADERS = [
  "Date", "Employee ID", "Employee Name",
  "Regular IN", "Regular OUT", "Regular Hours",
  "Overtime IN", "Overtime OUT", "Overtime Hours",
  "Total Daily Hours", "RowKey"
];
const EMP_HEADERS = ["Employee ID", "Name", "Photo URL", "Registered At"];
const SYNCLOG_HEADERS = ["Key", "Processed At"];
const SUMMARY_HEADERS = [
  "Month", "Employee ID", "Employee Name",
  "Days Present", "Days Absent (approx)", "Regular Hours", "Overtime Hours", "Grand Total Hours"
];

// ---------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------
function doGet(e) {
  return jsonResponse({ ok: true, message: "Hasan Enterprise Attendance API is running." });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const ss = getOrCreateSpreadsheet();

    const touchedMonths = new Set();

    if (body.employees && body.employees.length) {
      upsertEmployees(ss, body.employees);
    }

    if (body.records && body.records.length) {
      body.records.forEach((r) => {
        applyRecord(ss, r);
        touchedMonths.add(r.dateKey.slice(0, 7));
      });
    }

    touchedMonths.forEach((m) => rebuildMonthlySummary(ss, m));

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

// ---------------------------------------------------------------
// Spreadsheet / sheet helpers
// ---------------------------------------------------------------
function getOrCreateSpreadsheet() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty("SPREADSHEET_ID");

  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      // fall through and recreate if it was deleted
    }
  }

  const files = DriveApp.getFilesByName(SPREADSHEET_NAME);
  if (files.hasNext()) {
    const file = files.next();
    const ss = SpreadsheetApp.openById(file.getId());
    props.setProperty("SPREADSHEET_ID", ss.getId());
    ensureSheets(ss);
    return ss;
  }

  const ss = SpreadsheetApp.create(SPREADSHEET_NAME);
  props.setProperty("SPREADSHEET_ID", ss.getId());
  ensureSheets(ss);
  return ss;
}

function ensureSheets(ss) {
  getOrCreateSheetWithHeaders(ss, "Log", LOG_HEADERS);
  getOrCreateSheetWithHeaders(ss, "Employees", EMP_HEADERS);
  getOrCreateSheetWithHeaders(ss, "SyncLog", SYNCLOG_HEADERS);
  getOrCreateSheetWithHeaders(ss, "Monthly Summary", SUMMARY_HEADERS);

  // Remove the default "Sheet1" if it's still empty and unused.
  const defaultSheet = ss.getSheetByName("Sheet1");
  if (defaultSheet && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }
}

function getOrCreateSheetWithHeaders(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

// ---------------------------------------------------------------
// Employees
// ---------------------------------------------------------------
function upsertEmployees(ss, employees) {
  const sheet = ss.getSheetByName("Employees");
  const data = sheet.getDataRange().getValues();
  const idCol = 0;

  employees.forEach((emp) => {
    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(emp.id)) {
        rowIndex = i + 1; // 1-based sheet row
        break;
      }
    }

    let photoUrl = "";
    if (emp.photo && emp.photo.indexOf("data:image") === 0) {
      photoUrl = savePhotoToDrive(emp.id, emp.photo);
    }

    if (rowIndex === -1) {
      sheet.appendRow([emp.id, emp.name, photoUrl, new Date()]);
    } else {
      sheet.getRange(rowIndex, 2).setValue(emp.name);
      if (photoUrl) sheet.getRange(rowIndex, 3).setValue(photoUrl);
    }
  });
}

function savePhotoToDrive(employeeId, dataUrl) {
  try {
    const match = dataUrl.match(/^data:(image\/\w+);base64,(.*)$/);
    if (!match) return "";
    const contentType = match[1];
    const base64 = match[2];
    const bytes = Utilities.base64Decode(base64);
    const blob = Utilities.newBlob(bytes, contentType, `employee_${employeeId}.jpg`);

    let folders = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
    const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(PHOTO_FOLDER_NAME);

    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return file.getUrl();
  } catch (err) {
    return "";
  }
}

// ---------------------------------------------------------------
// Attendance records -> day-level log rows
// ---------------------------------------------------------------
function applyRecord(ss, record) {
  const syncKey = `${record.employeeId}_${record.timestamp}`;
  if (isAlreadyProcessed(ss, syncKey)) return;

  const sheet = ss.getSheetByName("Log");
  const rowKey = `${record.dateKey}_${record.employeeId}`;
  const data = sheet.getDataRange().getValues();
  const rowKeyCol = LOG_HEADERS.indexOf("RowKey");

  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][rowKeyCol]) === rowKey) {
      rowIndex = i + 1;
      break;
    }
  }

  if (rowIndex === -1) {
    const newRow = new Array(LOG_HEADERS.length).fill("");
    newRow[0] = record.dateKey;
    newRow[1] = record.employeeId;
    newRow[2] = record.employeeName;
    newRow[rowKeyCol] = rowKey;
    sheet.appendRow(newRow);
    rowIndex = sheet.getLastRow();
  }

  const timeOnly = Utilities.formatDate(
    new Date(record.timestamp),
    Session.getScriptTimeZone(),
    "HH:mm:ss"
  );

  const colMap = {
    REG_IN: 4, REG_OUT: 5, OT_IN: 7, OT_OUT: 8
  };
  const targetKey = `${record.mode === "OT" ? "OT" : "REG"}_${record.direction}`;
  const col = colMap[targetKey];
  if (col) sheet.getRange(rowIndex, col).setValue(timeOnly);

  recomputeHoursForRow(sheet, rowIndex);
  markProcessed(ss, syncKey);
}

function recomputeHoursForRow(sheet, rowIndex) {
  const row = sheet.getRange(rowIndex, 1, 1, LOG_HEADERS.length).getValues()[0];
  const regIn = row[3], regOut = row[4];
  const otIn = row[6], otOut = row[7];
  const dateKey = row[0];

  const regHours = hoursBetween(dateKey, regIn, regOut);
  const otHours = hoursBetween(dateKey, otIn, otOut);
  const total = (regHours || 0) + (otHours || 0);

  sheet.getRange(rowIndex, 6).setValue(regHours !== null ? regHours.toFixed(2) : "");
  sheet.getRange(rowIndex, 9).setValue(otHours !== null ? otHours.toFixed(2) : "");
  sheet.getRange(rowIndex, 10).setValue(total ? total.toFixed(2) : "");
}

function hoursBetween(dateKey, inTime, outTime) {
  if (!inTime || !outTime) return null;
  const start = new Date(`${dateKey}T${inTime}`);
  const end = new Date(`${dateKey}T${outTime}`);
  const diff = (end - start) / 3600000;
  return diff > 0 ? diff : null;
}

// ---------------------------------------------------------------
// De-duplication guard
// ---------------------------------------------------------------
function isAlreadyProcessed(ss, key) {
  const sheet = ss.getSheetByName("SyncLog");
  const values = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), 1).getValues();
  return values.some((r) => r[0] === key);
}
function markProcessed(ss, key) {
  ss.getSheetByName("SyncLog").appendRow([key, new Date()]);
}

// ---------------------------------------------------------------
// Monthly summary
// ---------------------------------------------------------------
function rebuildMonthlySummary(ss, monthKey) {
  const logSheet = ss.getSheetByName("Log");
  const data = logSheet.getDataRange().getValues();
  const rows = data.slice(1).filter((r) => String(r[0]).indexOf(monthKey) === 0);

  const byEmployee = {};
  rows.forEach((r) => {
    const id = r[1], name = r[2];
    if (!byEmployee[id]) {
      byEmployee[id] = { name, days: 0, regHours: 0, otHours: 0 };
    }
    if (r[3] || r[4] || r[6] || r[7]) byEmployee[id].days += 1;
    byEmployee[id].regHours += parseFloat(r[5]) || 0;
    byEmployee[id].otHours += parseFloat(r[8]) || 0;
  });

  const daysElapsedInMonth = daysElapsedSoFar(monthKey);

  const summarySheet = ss.getSheetByName("Monthly Summary");
  const existing = summarySheet.getDataRange().getValues();
  // Remove old rows for this month (keep header).
  for (let i = existing.length - 1; i >= 1; i--) {
    if (existing[i][0] === monthKey) summarySheet.deleteRow(i + 1);
  }

  Object.keys(byEmployee).forEach((id) => {
    const e = byEmployee[id];
    const absent = Math.max(daysElapsedInMonth - e.days, 0);
    const grand = e.regHours + e.otHours;
    summarySheet.appendRow([
      monthKey, id, e.name, e.days, absent,
      e.regHours.toFixed(2), e.otHours.toFixed(2), grand.toFixed(2)
    ]);
  });
}

function daysElapsedSoFar(monthKey) {
  const now = new Date();
  const [y, m] = monthKey.split("-").map(Number);
  const isCurrentMonth = now.getFullYear() === y && now.getMonth() + 1 === m;
  if (isCurrentMonth) return now.getDate();
  return new Date(y, m, 0).getDate(); // full days in a past month
}
