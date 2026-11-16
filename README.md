# Desk Time Tracker

A Chrome extension (also works in other Chromium browsers: Edge, Brave, etc.) that uses the webcam to measure how long
you actually sit at the computer, when you take breaks, and how much "computer time" really goes to your phone.
It also records time spent in browser tabs and takes periodic screenshots of the active tab.

Everything runs **locally**: camera frames are analyzed by neural networks inside the browser and are never stored or sent anywhere.
Only intervals like "10:02–10:47 at the computer" are saved.

## Installation

1. Unpack the archive into a permanent folder (e.g. `~/apps/desk-tracker`). Don't move it later: the ID of an unpacked
   extension depends on its path, and moving it creates a "new" extension with empty history.
2. Download the models (~10 MB):
   - **macOS / Linux:** `bash setup-models.sh`
   - **Windows:** right-click `setup-models.ps1` → "Run with PowerShell"
     (or `powershell -ExecutionPolicy Bypass -File .\setup-models.ps1`)
3. Open `chrome://extensions`, enable Developer mode → "Load unpacked" → select the folder.
4. The setup page opens: allow camera access and click "Start and calibrate" while looking at the screen for 5 seconds.
5. Pin the extension icon: the badge shows `ON` / `TEL` / `AFK`.

## How it works

```
Service worker (background.js, activity.js)   history, on/off, screen lock, tabs, screenshots
        │ creates
        ▼
Offscreen document (offscreen.js)             hidden page with a <video> from the webcam
        │ one frame per second →
        ├─ MediaPipe FaceLandmarker           face present? head tilt, gaze direction
        └─ MediaPipe ObjectDetector           "person" and "cell phone" in frame (EfficientDet, COCO)
        │
        ▼
raw state → smoothing → present / phone / away → IndexedDB
```

Rules:
- **Away**: no face and no person in frame for more than 10 s.
- **On the phone**: a phone is visible and the head or eyes are turned down (or the face is hidden) for more than 8 s.
- **At the computer**: everything else while you're in frame.
- The state changes only if the new one holds in ≥75% of frames for the configured time, so single model mistakes don't flip it.
- **Session**: continuous time at the computer. Absences shorter than 2 minutes (configurable) don't count as breaks.
- When the screen is locked, the camera turns off and the time is recorded as "away".
- After sleep, a frozen or disconnected camera is reopened automatically.

## Tabs and screenshots

**Tabs.** The extension records:
- which tab you were looking at and for how long (only while it's the active tab in a focused window);
- when the browser is minimized or you're in another app (gray on the timeline);
- a tab log: when each tab was opened and closed, its lifetime, time on screen and number of pages visited.

Tab time is paused when the camera sees you're away or the screen is locked.

**Screenshots.** Every N minutes (10 by default) the visible part of the active tab is captured and downscaled to 1280 px JPEG
(~50–150 KB). Screenshots are skipped when the browser is minimized, the screen is locked, you're away (per camera),
an extension page is open, or the site is in the exclusion list. `chrome://` pages and the Chrome Web Store can't be captured.
Take one manually with the 📸 button in the popup. The gallery is in the Screenshots tab of the stats page.

Screenshots capture everything on screen, including chats and banking pages. Add such sites to the exclusion list.

Screenshots use `chrome.alarms`, not `setInterval`, so they keep working after Chrome unloads the idle service worker.

**Permissions:** `tabs` for tab URLs and titles; `<all_urls>` to capture screenshots on a timer without clicking the icon.
Because of this, Chrome shows the warning "Read and change all your data on all websites". The extension does not read or
modify page content, but technically it could.

## Tuning accuracy

In the popup, expand "What the model sees right now" to see live signals: head tilt, eyes down, phone.
Compare them while sitting normally and while looking at your phone, then adjust thresholds on the stats page.

- A phone held below the camera often isn't visible → enable "Count a long look down as phone use".
  Downside: reading paper notes or looking at the keyboard will count too.
- If you change your seat or move the camera, calibrate again.

## Where data is stored

- **History** (presence, tab activity, tab log, screenshots) lives in the browser's IndexedDB (database `desk-tracker`)
  with the `unlimitedStorage` permission, so there's no size limit.
- **Settings** live in `chrome.storage.local`.
- Both are inside the Chrome profile (`~/.config/google-chrome/Default/...` on Linux).
- Data survives browser restarts and extension updates, but **is deleted together with the extension**
  and "disappears" if you move the unpacked extension folder. Export regularly.
- **Export / import** is on the stats page. Import can:
  - *merge*: add only records that don't overlap existing ones (importing the same file twice won't duplicate anything);
  - *replace*: wipe history and load the file;
  - optionally apply settings from the file.
- History from v1.0 is moved from `chrome.storage` to IndexedDB automatically.

## Using the camera in other apps (Linux)

Chrome shares the camera between its own tabs (e.g. Google Meet works alongside the tracker), but a separate app like
Zoom will see a black screen while Chrome holds the camera. A virtual camera fixes this:

```bash
sudo apt install v4l2loopback-dkms v4l-utils ffmpeg
sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="Shared Cam" exclusive_caps=1
ffmpeg -f v4l2 -input_format mjpeg -video_size 1280x720 -framerate 30 -i /dev/video0 \
       -pix_fmt yuv420p -f v4l2 /dev/video10
```

Then pick "Shared Cam" in `chrome://settings/content/camera` and in Zoom.

## Troubleshooting

- **"Model files not found"**: `setup-models` wasn't run, or you didn't click Reload on `chrome://extensions` afterwards.
- **Camera error**: the camera is busy in another app (Zoom, Teams) or permission wasn't granted; open the setup page.
- **`unsafe-eval` / WebAssembly error**: make sure `manifest.json` still contains `'wasm-unsafe-eval'`.
- Offscreen document logs: `chrome://extensions` → Desk Time Tracker → "Inspect views: offscreen.html".

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3, permissions: offscreen, storage, idle, alarms, unlimitedStorage, tabs |
| `background.js` | start/stop, presence intervals, screen lock, recovery after crashes |
| `activity.js` | tabs, browser focus, screenshots |
| `offscreen.js` | camera, models and state detection |
| `common.js` | default settings, session and break calculation |
| `db.js` | IndexedDB: writes, date-range queries, import, cleanup |
| `popup.*` | quick view of today |
| `stats.*` | sections: presence, tabs, screenshots, settings and data |
| `setup.*` | first run: model check, camera access, calibration |
