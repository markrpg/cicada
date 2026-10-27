# Cicada roadmap

Goal: a Mac and an Android phone send text and files to each other as insect-like chirps, reliably enough to film.

## Milestones

| ID | Milestone | Status | Check | Commit |
|----|-----------|--------|-------|--------|
| M1 | Modem: chirp preamble, two-band tick-train symbols, Reed–Solomon + CRC-32, streaming receiver, text/file packets | done | `npm test` passes (rate change + drift + echo + noise, back-to-back frames, 1 KB file through a 300 ms burst, noise-only, packets) | |
| M2 | Web app: listen/send, paste/copy, files, live spectrogram, progress bars, HTTPS LAN server | done | page loads with no console errors on desktop and mobile widths | |
| M3 | Over-the-air test Mac ↔ Android | todo | 10 messages each way at 30 cm and 1 m, success rate recorded | |
| M4 | Speed presets (faster symbols when devices are close) | todo | tests pass at each preset; M3 success rate holds for the fast preset at 30 cm | |
| M5 | Filming mode: full-screen visuals, big type, record-friendly layout | todo | screenshot at phone and laptop sizes | |
