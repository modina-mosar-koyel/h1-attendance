# Hasan Enterprise - Offline Attendance & Overtime App

A single-link, installable PWA for face-recognition attendance/overtime,
built for non-literate factory workers. Works 100% offline after first
load; auto-syncs to Google Sheets when the device is back online.

## What's inside
- `index.html`, `style.css`, `app.js`, `db.js`, `sync.js`, `sw.js`, `manifest.json`, `icons/` - the PWA
- `apps-script/Code.gs` - the Google Apps Script backend that writes to Sheets/Drive

## Part 1 - Deploy the Google Sheets backend (5 minutes)

1. Go to [script.google.com](https://script.google.com) and click **New project**.
2. Delete the placeholder code, paste in the entire contents of `apps-script/Code.gs`.
3. Click the **Save** icon, name the project "Hasan Enterprise Attendance Backend".
4. Click **Deploy -> New deployment**.
5. Click the gear icon next to "Select type" and choose **Web app**.
6. Set:
   - **Execute as:** Me
   - **Who has access:** Anyone
7. Click **Deploy**. The first time, Google will ask you to authorize the
   script - click **Authorize access**, choose your Google account, click
   **Advanced -> Go to Hasan Enterprise Attendance Backend (unsafe)**, then
   **Allow**. (This warning appears because it's your own unpublished
   script, not because anything is wrong.)
8. Copy the **Web app URL** it gives you (ends in `/exec`). You'll need it in Part 2.
9. The first time the app actually sends data, a new Google Sheet named
   **"Hasan Enterprise - Attendance & Overtime Log"** will appear automatically
   in your Google Drive, with tabs: `Log`, `Employees`, `Monthly Summary`, `SyncLog`.

## Part 2 - Configure the app

1. Open `app.js` in a text editor.
2. Find this line near the top:
   ```js
   const APPS_SCRIPT_URL = "PASTE_YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE";
   ```
   Replace the placeholder with the Web app URL you copied in Part 1, step 8.
3. Find this line and change the PIN to whatever you want admin access to require:
   ```js
   const ADMIN_PIN = "1234";
   ```

## Part 3 - Host it as a single link

The app must be served over **HTTPS** (required for camera access and
Service Workers). The simplest free options:

**Option A - GitHub Pages**
1. Create a new GitHub repository, upload all the files keeping the same
   folder structure (including the `icons/` folder).
2. Go to the repo's **Settings -> Pages**, set source to the `main` branch, root folder.
3. Your link will be `https://<your-username>.github.io/<repo-name>/`.

**Option B - Any static host you already use** (Netlify, Vercel, Firebase
Hosting, your own server with HTTPS) - just upload the folder as-is.

## Part 4 - First-time use on the phone/tablet

1. Open your live link in Chrome (Android) or Safari (iPhone) **while connected to internet** - this one-time load downloads and caches the face-recognition engine and all app files for offline use afterward.
2. Allow camera access when prompted.
3. Tap the gear icon (top right) -> enter your admin PIN -> **Register** tab.
4. Enter each employee's ID and Name, have them look at the camera, and tap
   **Capture Face Angle** three times (straight, slightly left, slightly
   right) for best accuracy. Tap **Save Employee**.
5. Repeat for every worker. Each registration is saved locally immediately
   and uploaded to the "Employees" tab + Drive photo folder next time
   you're online.
6. "Add to Home Screen" (browser menu) so staff can open it with one tap
   like a normal app icon.

## Daily use
- The camera starts automatically; workers just stand in front of it.
- The big toggle switches between **Regular Mode** and **Overtime Mode** -
  the same face scan then logs Regular IN/OUT or Overtime IN/OUT.
- A green checkmark, the worker's name/photo, and a spoken confirmation
  play on every successful scan.
- The badge at the top always shows the current state: `Offline Mode -
  Saved Locally (N pending)` or `All Synced`.
- Open the Google Sheet anytime from Drive on your phone to see live data;
  the `Monthly Summary` tab recalculates automatically after every sync.

## Notes & limitations (please read)
- **Face model download:** the face-recognition engine (`face-api.js`) and
  its model weight files load from a public CDN the *first* time the app
  is opened online, then the Service Worker caches them for good. If that
  first load fails, the scan screen will say so - just open it once with a
  normal internet connection.
- **"Days Absent"** in the Monthly Summary is an approximation
  (calendar days elapsed in the month minus days with any scan) since the
  app doesn't know your official working-day/weekend schedule. Adjust the
  `daysElapsedSoFar()` function in `Code.gs` if you want it to exclude
  weekends or holidays.
- **Accuracy:** face matching uses a 0.5 distance threshold
  (`MATCH_THRESHOLD` in `app.js`). If two people are being confused,
  lower it slightly (e.g. 0.45); if the same person isn't being
  recognized, raise it slightly (e.g. 0.55).
- **Multiple devices:** if you'll run this on more than one phone/tablet
  for the same factory, each device syncs to the same Google Sheet, but
  registered employees are stored locally per-device - register each
  employee on every device you plan to scan them on (the Apps Script
  will share names, but not the face data itself, since the face data
  never needs to leave the device for recognition to work).
