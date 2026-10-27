# Cicada

Copy something on your Mac. Send it to your Android phone as insect chatter.

Cicada turns text and small files into sound, plays it through one device’s speaker, and decodes it through the other’s microphone. Paste a message, send it, then copy it on the other side. A neon waterfall and glowing progress bar follow the transfer.

**[Download the Mac app and Android APK](https://github.com/markrpg/cicada/releases/tag/v0.2)**

## Why I built it

The idea came from reports about OpenAI’s red-team agents finding ways to communicate without a network or shared files. [That experiment used CPU-cache timing](https://www.tomshardware.com/tech-industry/artificial-intelligence/openais-isolated-red-team-ai-agents-built-a-hidden-cpu-cache-channel-to-talk-with-no-network-or-shared-files-exploited-cpu-cache-timing-to-bypass-microvm-sandboxes). It got me thinking about another channel computers already have: speakers and microphones.

The sound inspiration came from [the tower control sound in Westworld](https://www.youtube.com/watch?v=zYAZIbsmvP0). I wanted a transfer to feel like two machines chattering to each other. The audio is generated in code.

[Hear “Hello from Cicada” encoded as sound.](samples/delights.wav)

## Try it

1. Install **Cicada.app** on your Mac and **cicada-0.2.apk** on your Android phone from the download link above.
2. Open both apps and put the devices close together.
3. Tap **Listen** on the receiving device and allow microphone access.
4. Type or paste a short message on the other device, then press **Send**.
5. Watch it arrive, then tap **Copy**.

You can also pick a small file to send. Received files have a save button.

On Mac, Cicada lives in the menu bar under the waveform icon. Closing its window stops the audio; the icon stays available to reopen it.

Android needs version 10 or newer and may ask you to allow installation from your browser. The Mac app is ad-hoc signed, so a downloaded copy may need approval in **System Settings → Privacy & Security**.
## How much can it send?

Start with a sentence. This is slow: a full 700-byte packet takes about 169 seconds. Compression can fit larger original text or files into that limit. Each transmission begins with a short drone before the data-bearing chatter starts.

The payload travels through sound. Neither installed app needs a network connection to transfer it.

## Under the hood

The transmitter generates pairs of short, resonant cicada grains. Their relative loudness encodes the data. Reed–Solomon error correction and a CRC-32 check help the receiver recover and verify the message.

The Mac and Android apps share the same JavaScript modem and neon interface. The Mac shell uses Swift and WebKit; Android uses a WebView.

Sixteen automated tests pass, including audio-rate conversion, clock drift, noise, echo, interrupted transfers and WAV round trips. Real Mac↔Android acoustic testing is still pending. The Mac WebView’s worklet passed a synthetic-input check; real microphone capture, native dialogs and close/reopen behavior still need hands-on verification. Intel execution has not been tested.

## Build it

Android requires JDK 17 and the Android SDK:

```bash
cd android
./gradlew assembleDebug
```

Mac requires Xcode command-line tools:

```bash
bash macos/build.sh
open macos/build/Cicada.app
```

To use a browser instead, run `python3 tools/serve.py` and open the HTTPS address it prints. The server supplies the page; the transfer still goes over sound.

```bash
npm test
node tools/render-wav.js "your text" out.wav
```
