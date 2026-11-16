/* Hasan Enterprise Attendance - sync to Google Sheets via Apps Script */

const SyncManager = {
  syncing: false,

  init() {
    window.addEventListener("online", () => this.trySync());
    window.addEventListener("offline", () => this.refreshBadge());
    this.refreshBadge();
    // Also retry periodically in case the "online" event was missed
    // (common on some Android browsers).
    setInterval(() => this.trySync(), 30000);
  },

  async refreshBadge() {
    const badge = document.getElementById("syncBadge");
    if (!navigator.onLine) {
      const pending = await HasanDB.getPendingRecords();
      badge.textContent = pending.length
        ? `Offline Mode - Saved Locally (${pending.length} pending)`
        : "Offline Mode";
      badge.className = "badge badge-offline";
      return;
    }
    const pending = await HasanDB.getPendingRecords();
    const pendingEmployees = await HasanDB.getEmployeesPendingSync();
    const totalPending = pending.length + pendingEmployees.length;
    if (totalPending === 0) {
      badge.textContent = "All Synced";
      badge.className = "badge badge-synced";
    } else {
      badge.textContent = `Syncing... (${totalPending} pending)`;
      badge.className = "badge badge-pending";
    }
  },

  async trySync(manualTrigger) {
    if (this.syncing) return;
    if (!navigator.onLine) {
      await this.refreshBadge();
      return;
    }
    if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf("PASTE_YOUR") === 0) {
      console.warn("Apps Script URL not configured yet - skipping sync.");
      return;
    }

    this.syncing = true;
    try {
      const pendingRecords = await HasanDB.getPendingRecords();
      const pendingEmployees = await HasanDB.getEmployeesPendingSync();

      if (pendingRecords.length === 0 && pendingEmployees.length === 0) {
        await this.refreshBadge();
        this.syncing = false;
        return;
      }

      const payload = {
        records: pendingRecords.map((r) => ({
          recordId: r.recordId, // used client-side only, not required by server
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          mode: r.mode,
          direction: r.direction,
          timestamp: r.timestamp,
          dateKey: r.dateKey
        })),
        employees: pendingEmployees.map((e) => ({
          id: e.id,
          name: e.name,
          photo: e.photo
        }))
      };

      const response = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids CORS preflight
        body: JSON.stringify(payload)
      });

      if (!response.ok) throw new Error(`Server responded ${response.status}`);
      const result = await response.json();

      if (result.ok) {
        if (pendingRecords.length) {
          await HasanDB.markRecordsSynced(pendingRecords.map((r) => r.recordId));
        }
        for (const e of pendingEmployees) {
          await HasanDB.markEmployeeSynced(e.id);
        }
      } else {
        console.warn("Server reported sync issue:", result.error);
      }
    } catch (err) {
      console.warn("Sync failed, will retry later:", err);
    } finally {
      this.syncing = false;
      await this.refreshBadge();
      if (typeof renderQueue === "function") {
        try { renderQueue(); } catch (e) {}
      }
    }
  }
};
