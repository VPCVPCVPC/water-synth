# Water Synth — the phone and tablet app

The web instrument in `../prototype`, wrapped for the iPhone/iPad App Store
and Google Play with [Capacitor](https://capacitorjs.com) — one code base
(Dash, Oct 2026: release for phones and tablets first). Every change to the
prototype ships to the website, iOS and Android alike; nothing here is a
second copy of the instrument.

App web views can't use shared memory (SharedArrayBuffer), so in the app the
page and its audio engine talk over the worklet's message port instead
(`../prototype/bridge.js`) — chosen automatically, same behaviour.

## Building

```bash
cd app
npm install
npm run build        # builds ../prototype/dist and copies it into both apps
```

- **iOS:** `npm run ios` opens the Xcode project (`ios/App/App.xcodeproj`).
  Pick your team under Signing & Capabilities, then run on a simulator or a
  plugged-in iPhone/iPad. Builds here with Xcode alone (Swift Package
  Manager; no CocoaPods).
- **Android:** needs [Android Studio](https://developer.android.com/studio).
  `npm run android` opens the project; run it on an emulator or a phone.

After changing the prototype, `npm run build` again (it rebuilds `dist` and
syncs both apps).

## What's set up

- App name **Water Synth** (the working title), ID `com.watersynth.app` —
  **a placeholder: choose the real one before the first upload** (it can't
  change after).
- iOS: plays through the silent switch (the `playback` audio session, in
  `AppDelegate.swift`); camera permission text, a light status bar and no
  export-encryption question in `Info.plist`; a black background behind the
  page (`capacitor.config.json`).
- Android: camera permission in `AndroidManifest.xml`.

## Still to do before the stores

- **Accounts (Dash):** Apple Developer Program (US$99/year) and a Google
  Play developer account (US$25 once).
- **The app's ID and name** (above), version numbers.
- **Icons and launch screen** — Capacitor's defaults are in place now; make
  them from the ripple mark.
- **A privacy policy page** (both stores require one): the camera picture
  stays on the device; the feedback link sends device type and a few
  settings; nothing else leaves the phone.
- **Store listing:** description (true to "you don't play notes", like the
  how-to-play guide), screenshots (phone and tablet sizes), age rating,
  category (Music).
- **Words that assume a browser** ("your settings stay in this browser").
- **Record piece can't save in the apps yet:** the page's download link does
  nothing inside an app web view. Fix: hand the WAV to the share sheet
  (Capacitor's Filesystem and Share plugins, or the Web Share API with files).
- **A privacy manifest** (`PrivacyInfo.xcprivacy`) for the iOS app bundle.
- **Decide with device testing:** whether the instrument should mix with
  other apps' music (now it stops it, like most instruments); it doesn't play
  in the background (deliberate: the camera stops then too).
- **Test on real devices** — audio latency, the camera, the tape.
- Then TestFlight (iOS) and an internal test track (Android) before release.
