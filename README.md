# Cicada

Send text and files between a Mac and an Android phone as sound: rapid insect chatter, in the spirit of the Westworld tower sound. No network, Bluetooth or pairing carries the data. It goes from one device's speaker to the other's microphone.

Listen to one: [`samples/delights.wav`](samples/delights.wav).

## Android app

Download `cicada-0.1.apk` from the [latest release](../../releases/latest) on the phone and open it (allow installs from your browser when asked). Needs Android 10 or newer. The app bundles the same web page, so it needs no server or certificate.

Build it yourself with JDK 17 and the Android SDK:

```bash
cd android && ./gradlew assembleDebug
```

## Run it in a browser

Both devices open the same page in a browser. Over the LAN the phone needs HTTPS before it will allow the microphone, so:

```bash
python3 tools/serve.py
```

- **Mac:** open `https://localhost:8443`
- **Android (same Wi-Fi):** open the `https://<mac-ip>:8443` address it prints, then tap *Advanced → Proceed* on the certificate warning (the certificate is self-signed)

If the phone still won't give the page the mic, connect it by USB with debugging on, run `adb reverse tcp:8443 tcp:8443`, and open `https://localhost:8443` on the phone.

Tap **Listen** on the receiving device, then type, paste or drop a file on the other and send. Turn the sending device's volume up. Keep the devices within about a metre.

## How it sounds and works

| Part | What it is |
|------|------------|
| Preamble | A buzzing up-chirp then down-chirp (1.4–7.2 kHz). The receiver finds it by FFT cross-correlation, which gives sample-accurate timing. |
| Symbol | One byte every 80 ms. The high nibble picks one of 16 tones in 1.65–4 kHz, the low nibble one of 16 in 4.5–6.85 kHz. Each plays as four 9 ms ticks, the two bands alternating, which makes the cricket trill. |
| Errors | The header carries Reed–Solomon with 6 parity bytes. The body is split into blocks of up to 128 bytes, each with 16 parity bytes (fixes 8 bad symbols per block), interleaved so a clap or cough spreads over several blocks. CRC-32 on the payload. |
| Packets | Text or a file (name + type + bytes). Long text and files are deflate-compressed when it helps. |

Throughput is about 12 bytes/s, so a sentence takes a few seconds and a 1 KB file about 1½ minutes. In simulation the modem decodes reliably with noise 10 dB louder than the signal.

## Develop

```bash
npm test
```

```bash
node tools/render-wav.js "your text" out.wav
```

Code: `web/modem.js` (modulation and receiver), `web/rs.js` (Reed–Solomon), `web/packet.js` (text/file packing), `web/app.js` (UI and audio).
