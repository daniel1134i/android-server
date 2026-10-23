# 👾 Android Autonomous Server & Mac Controller

> Turn an Android tablet into a 24/7 low-power autonomous server, managed from macOS with a retro **Pixel Art × Claude Code** interface.

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────┐
│         macOS Controller Desktop App         │
│         (Claude Code & Pixel Aesthetic)      │
│  - Real-time Hardware Telemetry (CPU/RAM/Bat)│
│  - Remote Interactive Shell Console          │
│  - Remote File Browser & Downloader          │
│  - Power Management & Battery Preservation   │
└──────────────────────┬───────────────────────┘
                       │ HTTP/JSON RPC (port 8080)
                       │ (Wi-Fi or USB via adb forward)
┌──────────────────────▼───────────────────────┐
│           Android Autonomous Server          │
│   (Redmi Pad SE / Android 15 / 8-core CPU)   │
│  - Foreground Service (Zero-sleep kill)      │
│  - Partial WakeLock (Eco power mode)         │
│  - Ultra-lightweight Multi-threaded HTTP     │
│  - Battery Health & Thermal Protection       │
│  - OLED Screen Dimmer (90% display power cut)│
└──────────────────────────────────────────────┘
```

---

## ⚡ Energy Efficiency & 24/7 Longevity

1. **CPU & WakeLock Management:** The server daemon operates inside an Android `Foreground Service` holding an energy-optimized `PARTIAL_WAKE_LOCK`. The CPU remains responsive to incoming network requests while the screen and GPU are completely off.
2. **OLED Dim Mode:** One-tap screen dimming sets brightness to 1% with an OLED-friendly dark clock, cutting display energy consumption by up to 95%.
3. **Battery Longevity:** Telemetry monitors battery temperature in real time (alerts if > 42°C) and provides recommendations to keep charge between 20% and 80% to avoid battery swelling during continuous plugged-in operation.

---

## 🚀 Quick Start

### Android Server
- Path: `android-app/`
- Build APK: `./.tools/gradle-8.7/bin/gradle -p android-app assembleDebug`
- APK location: `android-app/app/build/outputs/apk/debug/app-debug.apk`

### macOS Controller
- Path: `mac-app/`
- Application installed at: `/Applications/AndroidServerController.app`
- Launch via terminal: `open /Applications/AndroidServerController.app` or `cd mac-app && npm start`
