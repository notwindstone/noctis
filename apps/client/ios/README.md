# Noctis for iOS

Built with [xtool](https://xtool.sh) (SwiftPM, no Xcode project), so it works from Linux.
`Package.swift` + `xtool.yml` + `Info.plist` describe the app; the Swift is in `Sources/Noctis`.

| File | What |
| --- | --- |
| `NoctisApp.swift`, `NoctisViewController.swift` | SwiftUI entry → Capacitor's `CAPBridgeViewController`; finds the web assets in the SwiftPM bundle |
| `NoctisPlugin.swift` | The `Noctis` Capacitor plugin (`src/native.ts`): haptics, lock screen controls, notifications, opened `.noctis` files |
| `WebSignIn.swift` | `openLogin`/`openAuth`/`openCookieLogin`/`captureResponse`/`clearCookies` with `WKWebView` |
| `LocalMusic.swift` | Music folders picked in Files (security-scoped bookmarks), tags and covers via AVFoundation |

`Sources/Noctis/public` and `capacitor.config.json` are symlinks to what `cap sync` writes into
`App/App`; `App/CapApp-SPM/Package.swift` is also Capacitor's. `App/App.xcodeproj` is a stub
that only tells the Capacitor CLI the iOS version.

## Build

One-time setup, from [xtool's Linux install guide](https://xtool.sh/documentation/xtooldocs/installation-linux):
Swift 6.4, `usbmuxd`, `Xcode.xip` (needs an Apple ID), then `xtool setup`.

```sh
cd apps/client
bun run ios          # build the web app, cap sync, then xtool dev (builds, signs, installs, launches)
bun run ios:build    # same, without installing
```

## Differences from Android

- No predictive back, Material You colours or wake lock: back is the web layer's edge swipe.
- Local music is folders only (no media index to scan); Ogg/Opus files play only if the web view can,
  and their tags aren't read.
- Notifications have no progress bar; the percentage goes in the text.
- Lock screen controls need the `audio` background mode (in `Info.plist`).
