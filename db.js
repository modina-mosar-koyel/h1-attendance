/* Hasan Enterprise Attendance - IndexedDB layer
   Two object stores:
   - "employees": one row per worker, with face descriptors + reference photo,
     stored locally so recognition works with zero internet.
   - "records": every attendance/overtime scan, synced or not. The offline
     queue is simply "records where synced === 0".
*/

const DB_NAME = "HasanAttendanceDB";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains("employees")) {
        const empStore = db.createObjectStore("employees", { keyPath: "id" });
        empStore.createIndex("pendingSync", "pendingSync", { unique: false });
      }

      if (!db.objectStoreNames.contains("records")) {
        const recStore = db.createObjectStore("records", {
          keyPath: "recordId",
          autoIncrement: true
        });
        recStore.createIndex("synced", "synced", { unique: false });
        recStore.createIndex("employeeId", "employeeId", { unique: false });
        recStore.createIndex("dateKey", "dateKey", { unique: false });
        recStore.createIndex("empDateMode", ["employeeId", "dateKey", "mode"], {
          unique: false
        });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

const HasanDB = {
  async addEmployee(employee) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const store = tx(db, "employees", "readwrite");
      const req = store.put(employee);
      req.onsuccess = () => resolve(employee);
      req.onerror = () => reject(req.error);
    });
  },

  async getAllEmployees() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const store = tx(db, "employees", "readonly");
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async getEmployeesPendingSync() {
    const all = await this.getAllEmployees();
    return all.filter((e) => e.pendingSync);
  },

  async markEmployeeSynced(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const store = tx(db, "employees", "readwrite");
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const emp = getReq.result;
        if (!emp) return resolve();
        emp.pendingSync = false;
        const putReq = store.put(emp);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  },

  async addRecord(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const store = tx(db, "records", "readwrite");
      const req = store.add(record);
      req.onsuccess = () => resolve(req.result); // returns new recordId
      req.onerror = () => reject(req.error);
    });
  },

  async getPendingRecords() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const store = tx(db, "records", "readonly");
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        resolve(all.filter((r) => r.synced === 0));
      };
      req.onerror = () => reject(req.error);
    });
  },

  async markRecordsSynced(recordIds) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const store = tx(db, "records", "readwrite");
      let remaining = recordIds.length;
      if (remaining === 0) return resolve();
      recordIds.forEach((id) => {
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          const rec = getReq.result;
          if (rec) {
            rec.synced = 1;
            rec.syncedAt = new Date().toISOString();
            store.put(rec);
          }
          remaining -= 1;
          if (remaining === 0) resolve();
        };
        getReq.onerror = () => reject(getReq.error);
      });
    });
  },

  // Last direction (IN/OUT) logged today for this employee+mode, used to
  // decide whether the next scan should log IN or OUT.
  async getLastDirectionToday(employeeId, mode, dateKey) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const store = tx(db, "records", "readonly");
      const idx = store.index("empDateMode");
      const req = idx.getAll([employeeId, dateKey, mode]);
      req.onsuccess = () => {
        const rows = req.result || [];
        if (rows.length === 0) return resolve(null);
        rows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        resolve(rows[rows.length - 1].direction);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async getAllRecords() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const store = tx(db, "records", "readonly");
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async getRecordsForDate(dateKey) {
    const all = await this.getAllRecords();
    return all.filter((r) => r.dateKey === dateKey);
  },

  async getRecordsForMonth(monthKey) {
    // monthKey like "2026-11"
    const all = await this.getAllRecords();
    return all.filter((r) => r.dateKey && r.dateKey.startsWith(monthKey));
  }
};
