# Cicada

Send text and small files between a Mac and an Android phone through their speakers and microphones. A low tower-like drone opens into rapid cicada grains. The grains carry the data through differences in their relative loudness.

Hear an encoded message: [`samples/delights.wav`](samples/delights.wav) carries “Hello from Cicada”. All audio is generated procedurally; no reference recording is bundled.

## Android

Version 0.2 requires Android 10 or newer. Install the APK on the phone, then allow microphone access when you tap Listen. Both devices must use the updated sound protocol; the original 0.1 APK is incompatible.

Build with JDK 17 and the Android SDK:

```bash
cd android
./gradlew assembleDebug
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk` from the project root.

## Mac menu-bar app

Build with Xcode command-line tools:

```bash
bash macos/build.sh
open macos/build/Cicada.app
```

The waveform menu-bar icon opens Cicada. Closing the window tears down its WebView and stops playback/capture; the menu-bar icon remains. Use its Quit item to exit.

The app bundles the same web assets as Android and serves them through a loopback-only asset listener. It needs no Python process or browser setup. Clipboard and file dialogs use native APIs.

The build contains arm64 and x86_64 code and uses ad-hoc signing. It has no Developer ID publisher identity or Apple notarization. Downloaded copies may need approval in System Settings → Privacy & Security. Intel execution and the macOS 13 deployment target have not been runtime-tested.

## Browser

```bash
python3 tools/serve.py
```

Open `https://localhost:8443` on the Mac. To use a phone browser, open the LAN address printed by the server and accept its self-signed certificate. The network serves the page; text and file payloads travel through sound.

Tap Listen on the receiver, then send text or pick a file on the other device. Paste and Copy support clipboard transfers.

## Limits

The raw encoded-byte rate is 5 bytes/s before error correction. A 700-byte packet takes about 169 seconds including the drone and synchronization. The packet limit applies after compression, so compressible text or files can start larger. Playback is bounded by a three-minute duration limit and a 128 MiB combined PCM/playback allocation budget.

The header uses six Reed–Solomon parity bytes. Payload blocks have up to 128 data bytes and 16 parity bytes, interleaved across the transmission. CRC-32 checks the reconstructed payload. The receiver tracks timing to accommodate different device audio clocks.

## Checks and remaining tests

`npm test` passes 16 tests covering all byte values, rate conversion, positive/negative clock drift, noise and echo, burst corruption, interrupted frames, output bounds and 16-bit WAV round trips. Real Mac-to-Android acoustic performance still needs device testing.

The native Mac WebView passed secure-context and AudioWorklet sample-delivery checks with a synthetic input. Real microphone permission/capture, native clipboard/file dialogs and window close/reopen behavior still need interactive verification. Android build and lint complete; Gradle reports an SDK XML-version warning.

```bash
npm test
node tools/render-wav.js "your text" out.wav
```

