# Artwork sources and licensing

The original mint maid, lilac dragon maid and application icon artwork were generated with **GPTimage2.5**, as stated by the project author, and provided for this project. The two 小龙娘 images were supplied separately by the user; their source and authorization are recorded below.

| Material | Current project files | Preparation |
| --- | --- | --- |
| Mint maid character | `assets/maid.png` | Supplied transparent character image |
| Lilac dragon maid character | `assets/characters/lilac-dragon.png` | Supplied transparent character image |
| 小龙娘-托腮 (`frost-glass-cheek`) | `assets/characters/frost-glass-cheek.png` | User-supplied `final-2.png`; unchanged PNG bytes |
| 小龙娘-端庄 (`frost-glass-idle`) | `assets/characters/frost-glass-idle.png` | User-supplied `final-1.png`; unchanged PNG bytes |
| Application icon artwork | `assets/app-icon-original.png` | Supplied icon image |
| Transparent icon master | `assets/app-icon-master.png` | Removal of the outer connected background; character artwork retained |
| Platform icon derivatives | `assets/app-icon.ico`, `assets/icons/*.png`, and macOS `.icns` | Resizing and format conversion from the icon master |

The corresponding files under `macos/assets/` use the same source artwork. The project contributors license their rights in the original mint maid, lilac dragon maid, application icon artwork and their derivatives under **CC BY 4.0**. The two 小龙娘 images are outside that existing grant. The license, attribution requirements, scope, and exclusions are in [ARTWORK_LICENSE.md](../ARTWORK_LICENSE.md) and [the legal text](../licenses/CC-BY-4.0.txt).

Suggested credit for the CC BY 4.0 materials: **Codex Maid Widget artwork, generated with GPTimage2.5, provided by Codex Maid Widget contributors, CC BY 4.0**, with a link to [this repository](https://github.com/Feeesack/codex-maid-widget).

## User-supplied 小龙娘 images (introduced in 0.3.40)

The user supplied the original `final-1.png` and `final-2.png` images and authorized their names and built-in use in this project. Both originals are preserved as 1381 × 1139, 8-bit RGBA PNG files, without image conversion or recompression. The Windows and macOS asset copies have the same bytes and SHA-256 values. This record does not assert additional independent copyright, a new third-party license, or a general reuse/relicensing grant for these images.

| Supplied original | Built-in asset | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `final-1.png` | `assets/characters/frost-glass-idle.png` | 1,608,135 | `090130109d051b1c0fd9e691a0582c309d2df8a1c6d7a00b3c3753c35f42f8ae` |
| `final-2.png` | `assets/characters/frost-glass-cheek.png` | 1,611,136 | `63fa79d524ce3dbecafc623804c9bb4c835b67e019783200051adea12c187f36` |

小龙娘-托腮 is the default for fresh settings and the fallback after removing the selected custom character. The built-in order is 小龙娘-托腮, 小龙娘-端庄, 薄荷女仆, 紫晶龙女仆. Existing valid selections, user-defined names and the original built-in assets are retained. The two supplied poses were added in 0.3.40 and received their current names and order in 0.3.41; the provenance and rights scope above apply to both.

## Other materials

`assets/codex-mark.svg` is a third-party OpenAI mark sourced from the [official OpenAI Agents repository](https://github.com/openai/openai-agents-python/blob/main/docs/assets/logo.svg). It is excluded from the project's artwork license. No trademark rights or endorsement are granted.

The project does not redistribute reference projects' whale images or animated media. Bubbles, dynamic text and animations are rendered by project code. Four press/release presets contain three pairs adapted from Kenney Interface Sounds and Impact Sounds (CC0), plus this project's original synthesized chirp (MIT). **气泡轻弹** is the default and first choice. See [interaction-audio.md](interaction-audio.md) and `assets/audio/manifest.json`; the corresponding macOS resources and notices match.

The 0.3.48 release candidate also includes the user-requested original DSH default audio pair (Ya1.mp3 / Ya2.mp3) as a fifth choice. Upstream excludes these assets from MIT; their original creator, source license and redistribution permission have not been independently verified. This project does not relicense them under MIT or CC BY 4.0 or claim that permission has been obtained. Fixed upstream references, hashes and the source notice are documented in [interaction-audio.md](interaction-audio.md).

The account reset chirp is synthesized locally. User-imported images retain their own rights and stay outside this artwork grant.

## Third-party UI icons and animation engine (0.3.45)

The toolbar and previous/next controls use six official Stroke Rounded icons from `@hugeicons/core-free-icons` 4.3.5: RefreshIcon, HeartIcon, Settings01Icon, EyeOffIcon, ArrowLeft01Icon and ArrowRight01Icon. Their path data is unchanged; SVG markup is produced mechanically from the official package. The fixed package integrity, original nodes and individual file hashes are recorded in `assets/ui/hugeicons/source.json`. The full MIT notice is preserved in `licenses/hugeicons-LICENSE.txt` and alongside the icons. These icons are outside the project's CC BY 4.0 artwork grant. Source: https://github.com/hugeicons/hugeicons .

The former project-written perspective turn is replaced by the official Motion Mini browser distribution, `framer-motion` 14.4.0 `dist/dom-mini.js`. Its original bytes, MIT license and provenance are retained under `src/vendor/motion/`. The project supplies integration code using the official animation API, rather than a custom interpolation algorithm. Source: https://github.com/motiondivision/motion . No Pro icon pack, restricted legacy static pack, Motion+ assets or runtime remote loader are included.

## Bubble-page editor icons and sorting (0.3.46)

The Hugeicons 4.3.5 Stroke Rounded subset now also covers all seven page icons, drag handles, default stars, move arrows and reset control. The original six toolbar/navigation assets are unchanged. All 16 SVGs retain official geometry and are recorded in `assets/ui/hugeicons/source.json`.

Sorting uses the original MIT-licensed SortableJS 1.15.7 `Sortable.min.js` from the fixed upstream release, matching the npm distribution byte for byte. Its complete license and version, commit, download, integrity and SHA256 records are under `src/vendor/sortable/`. The application configures official handle, animation, fallback and scroll options; it does not implement pointer interpolation or card-displacement animation. Source: https://github.com/SortableJS/Sortable .
