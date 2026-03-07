# Notes App — Multi-Platform

A personal markdown note-taking app available as a **web app**, **desktop app** (Electron), and **iOS app** (Capacitor).

All three platforms share the same core source code in `web/`.

## Structure

```
Notes_App/
├── web/                 # Core web app (HTML/CSS/JS)
│   ├── index.html
│   ├── script.js
│   ├── styles.css
│   └── 001_Assets/
├── desktop/             # Electron wrapper
│   ├── main.js
│   ├── preload.js
│   ├── package.json
│   └── setup.sh
└── ios/                 # Capacitor wrapper
    ├── capacitor.config.ts
    ├── package.json
    └── setup.sh
```

## Web

Open `web/index.html` directly in a browser, or serve it:

```bash
cd web
python3 -m http.server 8000
```

## Desktop (Electron)

```bash
cd desktop
bash setup.sh    # installs deps + symlinks web/
npm start        # launches the desktop app
```

Requires: Node.js 18+

## iOS (Capacitor)

```bash
cd ios
bash setup.sh    # installs deps, copies web files, adds iOS platform
npm run open     # opens Xcode
```

Requires: Node.js 18+, Xcode 15+, macOS
