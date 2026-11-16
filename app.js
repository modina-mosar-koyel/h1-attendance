/* Hasan Enterprise Attendance - main app logic */

// ======================= CONFIG =======================
// Paste the Web App URL you get after deploying Code.gs (see README).
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw--CTcabuiTV2UoeK2n3FuYfGivE7WPYxu7nQ3zoAl9DvAzA6zV8EZmxH4qLLs5qqi/exec";
// Change this PIN before giving the device to staff.
const ADMIN_PIN = "264522";
// Face match threshold - lower = stricter. 0.5-0.55 works well in practice.
const MATCH_THRESHOLD = 0.5;
// Don't log the same employee+mode twice within this many seconds.
const COOLDOWN_SECONDS = 8;
// Model weights, loaded once online then cached by the Service Worker.
const MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";
// ========================================================

let currentMode = "REG"; // or "OT"
let mainStream = null;
let detectLoopHandle = null;
let lastSeen = {}; // employeeId+mode -> last logged timestamp (ms), cooldown guard
let employeesCache = [];
let labeledDescriptors = null;
let modelsReady = false;

const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const scanHint = document.getElementById("scanHint");
const otToggle = document.getElementById("otToggle");
const otToggleLabel = document.getElementById("otToggleLabel");

const feedbackOverlay = document.getElementById("feedbackOverlay");
const feedbackPhoto = document.getElementById("feedbackPhoto");
const feedbackName = document.getElementById("feedbackName");
const feedbackAction = document.getElementById("feedbackAction");
const feedbackTime = document.getElementById("feedbackTime");

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7); // YYYY-MM
}
function pad2(n) { return String(n).padStart(2, "0"); }
function timeStr(d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ---------------------------------------------------------------
// Startup
// ---------------------------------------------------------------
window.addEventListener("load", init);

async function init() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW failed", e));
  }

  await loadModels();
  await refreshEmployeeDescriptors();
  await startMainCamera();
  startDetectLoop();

  SyncManager.init(); // sets up online/offline listeners + badge
  wireUI();
}

async function loadModels() {
  scanHint.textContent = "Loading face recognition (first time needs internet)...";
  try {
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    modelsReady = true;
    scanHint.textContent = "Stand in front of the camera";
  } catch (err) {
    console.error(err);
    scanHint.textContent = "Models not cached yet - connect to internet once, then it works offline.";
  }
}

async function refreshEmployeeDescriptors() {
  employeesCache = await HasanDB.getAllEmployees();
  labeledDescriptors = employeesCache
    .filter((e) => e.descriptors && e.descriptors.length)
    .map(
      (e) =>
        new faceapi.LabeledFaceDescriptors(
          e.id,
          e.descriptors.map((d) => new Float32Array(d))
        )
    );
}

async function startMainCamera() {
  try {
    mainStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 480, height: 640 },
      audio: false
    });
    video.srcObject = mainStream;
  } catch (err) {
    scanHint.textContent = "Camera access denied. Please allow camera permission.";
    console.error(err);
  }
}

// ---------------------------------------------------------------
// Detection loop
// ---------------------------------------------------------------
function startDetectLoop() {
  if (detectLoopHandle) clearInterval(detectLoopHandle);
  detectLoopHandle = setInterval(runDetection, 1200);
}
function stopDetectLoop() {
  if (detectLoopHandle) clearInterval(detectLoopHandle);
  detectLoopHandle = null;
}

async function runDetection() {
  if (!modelsReady || !video.srcObject || !feedbackOverlay.classList.contains("hidden") === false) {
    // feedback currently showing - skip scanning until it clears
  }
  if (!modelsReady || !video.srcObject) return;
  if (!feedbackOverlay.classList.contains("hidden")) return; // busy showing last result
  if (!labeledDescriptors || labeledDescriptors.length === 0) {
    scanHint.textContent = "No employees registered yet - use Admin > Register";
    return;
  }

  const detection = await faceapi
    .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) {
    scanHint.textContent = "Stand in front of the camera";
    return;
  }

  const matcher = new faceapi.FaceMatcher(labeledDescriptors, MATCH_THRESHOLD);
  const best = matcher.findBestMatch(detection.descriptor);

  if (best.label === "unknown") {
    scanHint.textContent = "Face not recognized - ask admin to register you";
    return;
  }

  const employeeId = best.label;
  const key = `${employeeId}_${currentMode}`;
  const now = Date.now();
  if (lastSeen[key] && now - lastSeen[key] < COOLDOWN_SECONDS * 1000) {
    return; // cooldown, avoid duplicate logging
  }
  lastSeen[key] = now;

  await logAttendance(employeeId);
}

// ---------------------------------------------------------------
// Logging an attendance/overtime scan
// ---------------------------------------------------------------
async function logAttendance(employeeId) {
  const employee = employeesCache.find((e) => e.id === employeeId);
  if (!employee) return;

  const dateKey = todayKey();
  const lastDir = await HasanDB.getLastDirectionToday(employeeId, currentMode, dateKey);
  const direction = lastDir === "IN" ? "OUT" : "IN";
  const now = new Date();

  const record = {
    employeeId,
    employeeName: employee.name,
    mode: currentMode, // REG or OT
    direction, // IN or OUT
    timestamp: now.toISOString(),
    dateKey,
    synced: 0
  };

  await HasanDB.addRecord(record);
  showFeedback(employee, record, now);
  SyncManager.trySync(); // fire and forget - queues if offline
  SyncManager.refreshBadge();
}

function showFeedback(employee, record, now) {
  feedbackPhoto.src = employee.photo || "";
  feedbackName.textContent = employee.name;
  const modeLabel = record.mode === "OT" ? "Overtime" : "Regular";
  feedbackAction.textContent = `${modeLabel} ${record.direction}`;
  feedbackTime.textContent = timeStr(now);
  feedbackOverlay.classList.remove("hidden");

  speak(`Thank you, ${employee.name}, ${modeLabel} ${record.direction === "IN" ? "check in" : "check out"} recorded`);

  setTimeout(() => {
    feedbackOverlay.classList.add("hidden");
  }, 3000);
}

function speak(text) {
  try {
    if (!("speechSynthesis" in window)) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 0.95;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  } catch (e) {
    console.warn("speech failed", e);
  }
}

// ---------------------------------------------------------------
// UI wiring: OT toggle + Admin panel
// ---------------------------------------------------------------
function wireUI() {
  otToggle.addEventListener("click", () => {
    currentMode = currentMode === "REG" ? "OT" : "REG";
    const isOT = currentMode === "OT";
    otToggle.classList.toggle("overtime", isOT);
    otToggleLabel.textContent = isOT ? "OVERTIME MODE" : "REGULAR MODE";
  });

  document.getElementById("adminBtn").addEventListener("click", openAdminPin);
  document.getElementById("pinCancel").addEventListener("click", closeAdmin);
  document.getElementById("adminCloseBtn").addEventListener("click", closeAdmin);
  document.getElementById("pinSubmit").addEventListener("click", submitPin);
  document.getElementById("pinInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitPin();
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.getElementById("captureAngleBtn").addEventListener("click", captureAngle);
  document.getElementById("saveEmployeeBtn").addEventListener("click", saveNewEmployee);
  document.getElementById("forceSyncBtn").addEventListener("click", () => SyncManager.trySync(true));
  document.getElementById("monthPicker").addEventListener("change", renderMonthly);
}

function openAdminPin() {
  document.getElementById("adminOverlay").classList.remove("hidden");
  document.getElementById("pinGate").classList.remove("hidden");
  document.getElementById("adminContent").classList.add("hidden");
  document.getElementById("pinInput").value = "";
  document.getElementById("pinError").classList.add("hidden");
}

function submitPin() {
  const val = document.getElementById("pinInput").value;
  if (val === ADMIN_PIN) {
    document.getElementById("pinGate").classList.add("hidden");
    document.getElementById("adminContent").classList.remove("hidden");
    stopDetectLoop();
    resetRegistrationForm();
    renderToday();
    renderQueue();
    document.getElementById("monthPicker").value = monthKey();
    renderMonthly();
    // Share the same camera stream with the registration preview.
    document.getElementById("regVideo").srcObject = mainStream;
  } else {
    document.getElementById("pinError").classList.remove("hidden");
  }
}

function closeAdmin() {
  document.getElementById("adminOverlay").classList.add("hidden");
  startDetectLoop();
}

function switchTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tabName}`));
}

// ---------------------------------------------------------------
// Admin: register new employee
// ---------------------------------------------------------------
let captureBuffer = [];

function resetRegistrationForm() {
  captureBuffer = [];
  document.getElementById("newEmpId").value = "";
  document.getElementById("newEmpName").value = "";
  document.getElementById("regStatus").textContent = "";
  document.getElementById("saveEmployeeBtn").disabled = true;
  document.querySelectorAll(".angle-pill").forEach((p) => p.classList.remove("done"));
}

async function captureAngle() {
  const regVideo = document.getElementById("regVideo");
  const status = document.getElementById("regStatus");
  if (!modelsReady) {
    status.textContent = "Models still loading, try again in a moment.";
    return;
  }
  status.textContent = "Capturing...";

  const detection = await faceapi
    .detectSingleFace(regVideo, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) {
    status.textContent = "No face detected - look at the camera and try again.";
    return;
  }

  captureBuffer.push(Array.from(detection.descriptor));
  const n = captureBuffer.length;
  const pill = document.querySelector(`.angle-pill[data-n="${n}"]`);
  if (pill) pill.classList.add("done");
  status.textContent = `Captured angle ${n} of 3`;

  if (n === 1) {
    // Save a snapshot photo from the first good capture, for feedback screen.
    const canvas = document.createElement("canvas");
    canvas.width = regVideo.videoWidth;
    canvas.height = regVideo.videoHeight;
    canvas.getContext("2d").drawImage(regVideo, 0, 0);
    captureBuffer.photoDataUrl = canvas.toDataURL("image/jpeg", 0.8);
  }

  if (n >= 3) {
    document.getElementById("saveEmployeeBtn").disabled = false;
    status.textContent = "3 angles captured - ready to save.";
  }
}

async function saveNewEmployee() {
  const id = document.getElementById("newEmpId").value.trim();
  const name = document.getElementById("newEmpName").value.trim();
  const status = document.getElementById("regStatus");

  if (!id || !name) {
    status.textContent = "Enter both Employee ID and Name.";
    return;
  }
  if (captureBuffer.length < 3) {
    status.textContent = "Capture 3 face angles first.";
    return;
  }

  const employee = {
    id,
    name,
    descriptors: captureBuffer.slice(0, 3),
    photo: captureBuffer.photoDataUrl || "",
    pendingSync: true
  };

  await HasanDB.addEmployee(employee);
  await refreshEmployeeDescriptors();
  status.textContent = `${name} registered and saved for offline use.`;
  resetRegistrationForm();
  SyncManager.trySync();
}

// ---------------------------------------------------------------
// Admin: today's list / queue / monthly report
// ---------------------------------------------------------------
async function renderToday() {
  const rows = await HasanDB.getRecordsForDate(todayKey());
  const list = document.getElementById("todayList");
  rows.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  list.innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            `<div class="data-row"><span>${r.employeeName} - ${r.mode} ${r.direction}</span><span>${timeStr(new Date(r.timestamp))}</span></div>`
        )
        .join("")
    : "<p>No scans yet today.</p>";
}

async function renderQueue() {
  const pending = await HasanDB.getPendingRecords();
  const pendingEmployees = await HasanDB.getEmployeesPendingSync();
  const list = document.getElementById("queueList");
  const parts = [];
  if (pending.length) {
    parts.push(
      pending
        .map(
          (r) =>
            `<div class="data-row"><span>${r.employeeName} - ${r.mode} ${r.direction}</span><span>${new Date(r.timestamp).toLocaleString()}</span></div>`
        )
        .join("")
    );
  }
  if (pendingEmployees.length) {
    parts.push(
      pendingEmployees
        .map((e) => `<div class="data-row"><span>New employee: ${e.name}</span><span>pending</span></div>`)
        .join("")
    );
  }
  list.innerHTML = parts.length ? parts.join("") : "<p>Nothing pending - all synced.</p>";
}

async function renderMonthly() {
  const mKey = document.getElementById("monthPicker").value || monthKey();
  const rows = await HasanDB.getRecordsForMonth(mKey);
  const byEmployee = {};

  rows.forEach((r) => {
    if (!byEmployee[r.employeeId]) {
      byEmployee[r.employeeId] = {
        name: r.employeeName,
        days: new Set(),
        regMinutes: 0,
        otMinutes: 0,
        _pairs: { REG: {}, OT: {} }
      };
    }
    const e = byEmployee[r.employeeId];
    e.days.add(r.dateKey);
    const pairKey = `${r.dateKey}`;
    if (!e._pairs[r.mode][pairKey]) e._pairs[r.mode][pairKey] = {};
    e._pairs[r.mode][pairKey][r.direction] = r.timestamp;
  });

  Object.values(byEmployee).forEach((e) => {
    ["REG", "OT"].forEach((mode) => {
      Object.values(e._pairs[mode]).forEach((pair) => {
        if (pair.IN && pair.OUT) {
          const mins = (new Date(pair.OUT) - new Date(pair.IN)) / 60000;
          if (mins > 0) {
            if (mode === "REG") e.regMinutes += mins;
            else e.otMinutes += mins;
          }
        }
      });
    });
  });

  const list = document.getElementById("monthlyList");
  const entries = Object.values(byEmployee);
  list.innerHTML = entries.length
    ? entries
        .map((e) => {
          const reg = (e.regMinutes / 60).toFixed(1);
          const ot = (e.otMinutes / 60).toFixed(1);
          const total = (parseFloat(reg) + parseFloat(ot)).toFixed(1);
          return `<div class="data-row"><span>${e.name}</span><span>${e.days.size}d | Reg ${reg}h | OT ${ot}h | Total ${total}h</span></div>`;
        })
        .join("")
    : "<p>No records for this month yet.</p>";
}
