# TrigPoint v2.2

## Files
```
index.html       — App shell
css/styles.css   — All styles
js/app.js        — All logic
manifest.json    — PWA manifest (enables install to homescreen)
sw.js            — Service worker (offline support)
icons/           — App icons (192px, 512px)
```

## Deployment

### GitHub Pages (recommended)
1. Push all files to your GitHub repo (e.g. `byatto/tp`)
2. Go to repo Settings → Pages → Source → Deploy from branch → `main` / `root`
3. Your app will be live at `https://byatto.github.io/tp/`

### Self-hosted
Upload all files to any web server. The service worker requires HTTPS.

---

## Installing on Android (Chrome)

Once deployed to HTTPS:

1. Open the app URL in Chrome on your Android device
2. Tap the **⋮** menu (top right)
3. Tap **"Add to Home screen"** or **"Install app"**
4. Chrome will show the TrigPoint icon — tap **Install**
5. The app appears on your home screen and launches full-screen with no browser chrome

The app works fully offline once installed — all data is stored locally on the device.

---

## Installing on iOS (Safari)

1. Open the app URL in **Safari** (not Chrome — iOS PWA install only works in Safari)
2. Tap the **Share** button (box with arrow)
3. Scroll down and tap **"Add to Home Screen"**
4. Tap **Add**

---

## Cloud Sync

TrigPoint syncs via a Google Apps Script webhook. To configure:
1. Open **Settings** (gear icon) → Cloud config
2. Paste your Apps Script URL and API key
3. Tap Save — the app will sync immediately

Data uses last-write-wins merge, so it's safe to use across multiple devices.
