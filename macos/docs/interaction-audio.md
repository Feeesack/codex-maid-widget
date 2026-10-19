# Interaction audio source and processing

## Current library (0.3.48)

The public library contains four matched press/release presets, ordered **气泡轻弹**, **轻柔弹簧**, **经典啾啾**, and **木质轻敲**. **气泡轻弹** (`bubble-pop`) is the default and first choice. Selection is saved locally as `interactionSound`; missing, removed or invalid choices resolve to the new default. Existing retained presets keep their WAV bytes and base gains; the shared runtime gain adjustment is described below. Preview uses the selected pair and respects the existing mute switch.

Three presets use distinct source pairs from Kenney's [Interface Sounds](https://kenney.nl/assets/interface-sounds) and [Impact Sounds](https://kenney.nl/assets/impact-sounds), both CC0. Source pages, official archives, input/output hashes, processing parameters and original notices are retained in `assets/audio/manifest.json` and the adjacent license files, mirrored on macOS. The default uses `Audio/drop_001.ogg` / `Audio/drop_002.ogg` from Interface Sounds. The five removed choices and their ten WAVs are absent from both public asset directories and generated sample modules. UI Audio and Digital Audio notices are also removed because those packs are no longer used.

The original preset reconstructs the 0.3.33 oscillator: sine rising exponentially from 730 to 1050 Hz over 100 ms, with its original attack/decay and 220 ms total length. Press is the first 50 ms; release is the original 10–220 ms segment. Summing the two source PCM clips with 40 ms overlap reconstructs the reference to within one 16-bit PCM unit; playback also applies the short de-click envelope. Both portions remain audible separately after a long hold. The final 5 ms fades to zero. It is not two copies of the whole old sound; `synthesizeOriginalClips()` in the preparation script reproduces the reference and split. Its base gain remains 1; the other presets retain base gain .5. These base gains are multiplied by the shared runtime adjustment below.

The widget decodes each selected pair once and caches by fixed preset ID. Changing presets invalidates pending playback, so late decoding cannot mix pairs. All sound bytes are local, with no audio network fetch. Dragging retains the compressed character/bubble pose and the sound gesture: the press finishes naturally, and only pointer release starts the visual rebound and matching release clip. Mute still stops queued sounds, and a new press cancels old tails. The 0.3.34 animation curve is unchanged.

## Runtime level adjustment (0.3.48)

All interaction presets, including the local-only fifth choice, use 1.4 times their previous playback gain (about +2.9 dB). Only the default bubble-pop press receives an additional 1.6 multiplier (about +4.1 dB); its release keeps the shared multiplier. The preset and its role levels are captured for each gesture, so switching sounds cannot mix old and new clips. Widget interaction and settings preview use the same player. PCM, embedded samples, pitch, length and 40 ms overlap remain unchanged. These are playback-amplitude changes, not claims about a fixed percentage of perceived loudness. Offline rendered peak/RMS and overlap checks are recorded with the local delivery; subjective listening remains user acceptance.

## User-requested DSH audio, local only

The local installation can additionally offer **DSH 小黄鸭**, copied byte-for-byte from the original DSH default group: `Ya1.mp3` for press and `Ya2.mp3` for release at commit `5247dd6813d6e4430728f39ccc63d43cda046022`. `D1.mp3` / `D2.mp3` belong to DSH's alternate group, not its default. The [upstream group definitions](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/blob/5247dd6813d6e4430728f39ccc63d43cda046022/lib/index.js) establish this mapping.

These audio assets are **not MIT or CC0**. The upstream [PROVENANCE.md](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/blob/5247dd6813d6e4430728f39ccc63d43cda046022/PROVENANCE.md) expressly excludes `assets/**` from MIT, provides them as-is with that plugin only for running that plugin, and grants no relicensing. The user's local request does not grant third-party reuse or redistribution rights. No permission for distributing these assets with this project has been obtained.

The original files, notice, fixed source references and hashes remain in private local verification storage. A private build may explicitly overlay a user-designated local sample module; the committed `local-interaction-samples.js` files are empty stubs. Normal/public builds do not load the private payload, and `prepare-interaction-audio.cjs` always filters out catalog choices marked `localOnly`. The MP3s and their encoded data are excluded from the public source, public archives, installers and release assets. Publication would require a separate rights review; no GitHub publication is authorized by this local update.

## Retained soft-spring provenance (0.3.34)

The two `soft-spring` interaction samples are from [Kenney Interface Sounds 1.0](https://kenney.nl/assets/interface-sounds), created/distributed by Kenney, dated 2020-02-11. The pack is CC0; the original notice is retained at `assets/audio/Kenney-License.txt`, with matching macOS copies.

Official archive: https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip

| Event | Original file | Original SHA-256 | Processed SHA-256 |
| --- | --- | --- | --- |
| Press | `Audio/minimize_008.ogg` | `bc14c17875436dcaaf809c25db5e61454dbc35612880f329ff37a95ef9b6a865` | `d82391669c399d0be5b4826f2e702b6c39a4ffad4894e37e682ee3f08cddf90d` |
| Release | `Audio/maximize_008.ogg` | `57c074e600e193a303ce781c04c0ccc191c6030f9f106594fd94a65e55435c17` | `d96d217acf9abd603ed249d1884528134f3be21f2a2af3bb4da26db506344d92` |

Processing: decode the 44.1 kHz mono source, remove DC, resample at 1.5× speed, apply a 2 ms fade-in and 8 ms fade-out, normalize the peak to −6 dB, and add 1 ms silence at each end. Each output is 152.222 ms, mono 16-bit PCM WAV at 44.1 kHz, 13,470 bytes. The downward/upward pair is softer than Kenney UI Audio's mechanical mouse pair; Kenney Impact Sounds has no equally direct reverse pair. This selection is based on their paired design and signal analysis; subjective listening remains user acceptance.

The committed WAVs are the runtime source. `node scripts/prepare-interaction-audio.cjs` embeds those exact bytes into the two platform sample modules; `--check` verifies them without writing. Playback decodes local bytes once, with no fetch or CSP/network changes. Release starts immediately after a long hold, or overlaps the final 40 ms of the press after a short tap. A new gesture fades/cancels the previous voices; stale decode results cannot start a previous gesture. Muting cancels pending sounds. Account reset alerts retain their single synthesized chirp.

Interaction reference: [DSH v0.4.2 source](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/blob/5247dd6813d6e4430728f39ccc63d43cda046022/assets/whale-widget.js) and [PR #243](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/243). Use a 220 ms overshooting transform transition from the current displayed pose; do not queue clicks or delay release with a minimum-hold timer. Native corner movement uses separate translation properties. During a drag the widget retains the compressed transform; release rebounds independently of the native movement.
