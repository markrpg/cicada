# Cicada roadmap

Goal: a Mac and an Android phone send text and files as reference-C-style tower/cicada sound, with neon visuals and a Mac menu-bar app. Keep private media, credentials and machine-local data out of public artifacts.

## Milestones
Lanes: 1

| ID | Milestone | Status | Check | Commit |
|----|-----------|--------|-------|--------|
| M1 | Original modem and text/file packets | done | Nine original modem/packet tests passed | d205178 |
| M2 | Neon web UI and original Android APK | done | Browser receive checked at desktop/mobile widths; debug APK built | 0a76460 |
| M3 | Over-the-air Mac ↔ Android test | parked | Ten messages each way at 30 cm and 1 m, success rate recorded | |
| M6 | Reference-C procedural data-bearing buzz | done | Grain-pair sound feedback accepted; sixteen tests and exact WAV decode pass | 6baea7b |
| M7 | Native Mac menu-bar shell and audio lifecycle | parked | Standalone app launches; loopback worklet proof; close/reopen stops audio safely | |
| M9 | Alien procedural modem theme and automatic detection | doing | Both themes round-trip under channel tests; default Cicada unchanged; encoded Alien WAV delivered | |
| M10 | Theme picker and matching visuals | todo | Cicada default, saved selection, preview and per-transfer timing checked at phone/desktop widths | |
| M8 | Integrate, package and privacy-review both apps | todo | Updated APK and Mac ZIP inspected; browser regressions checked; private artifact/history scan reviewed | |
| M4 | Speed presets | todo | Each preset passes modem tests and real-device success check | |
| M5 | Filming mode refinements | todo | Screenshot at phone and laptop sizes | |
