# Changelog

## 0.5.15 — Project relocation and CI maintenance

- Fix chat-project relocation on Node versions that reject an already-created copy destination. Existing projects are preserved, and overlapping or occupied destinations remain rejected.
- Update native-window fixtures for the compressed stdin bootstrap and current Windows visibility/close behavior. Open the display settings panel before real pointer drag checks.
- Isolate synthetic chat-service tests from unrelated native model initialization; real semantic retrieval remains covered separately.
- Source and local runtime maintenance version. The published v0.5.14 installers and checksums remain unchanged.

- 修复聊天项目迁移时预先创建目标目录导致的 `EEXIST`，保留原目录、重叠及已占用目标保护。
- 更新原生窗口测试以匹配压缩 stdin 引导协议和当前 Windows 显示/关闭流程；真实拖拽测试先打开显示设置面板。
- 合成聊天服务测试隔离无关的原生模型初始化，真实语义检索仍有独立回归覆盖。
- 本节记录源码及本机维护版本；已发布的 v0.5.14 安装包与校验值保持不变。

## 0.5.14 — Companion chat, persistent memory, reset reminders and a clearer interface

This release collects the updates since public v0.3.51. See the [bilingual release notes](docs/releases/0.5.14.md) for downloads, upgrade guidance and validation limits.

- Add optional text/image companion chat through the signed-in Codex account, checkpoint archives with original images, persistent persona/preferences/facts, offline history retrieval and controlled conversation handoff.
- Add native chat usage records, independent archive metadata, seven chat-management pages and five settings categories. Refresh the verified native model catalog, including Terra when available.
- Improve the chat bubble and add an expandable writing card, preserving the input node, drafts, selection and input-method composition. Enter adds a line, Ctrl/Cmd+Enter sends, and Escape collapses it.
- Preserve the original thread and draft through writer conflicts, authentication errors and capacity reconciliation. Migrate compatible capacity proofs after program/CLI upgrades without replaying unknown requests.
- Improve account quota displays, reset forecasts, current-conversation selection, CLI discovery and damaged-settings recovery. Add bounded public reset announcement/observation data with source citations, deadlines, freshness and stale/offline fallback; keep announcement, observation, Tibo self-report and real quota confirmation separate. Retain original characters/audio and user settings; Windows follows Codex with an owned top-level window.
- Chat and model-based maintenance consume account quota; quota display alone makes no model requests. The worker shutdown fix passes the focused real-backend service regression; full-suite platform fixture failures, the unfinished older full-UI check, native Mac validation and user experience acceptance remain separately tracked.

本版本汇总 v0.3.51 以来的更新。详见[中英发布说明](docs/releases/0.5.14.md)。

- 新增图文桌宠聊天、带原图的可追溯归档、持久人设/偏好/事实、离线检索和受控换聊。
- 新增聊天原生用量账本、独立归档整理元数据、七类聊天管理和五类设置；动态读取经过核验的模型目录。
- 放大气泡正文，新增展开书写卡片，保留同一输入节点、草稿、选区和输入法状态。
- 核对恢复区分占用、认证、容量与未知执行；兼容容量证明可在程序/CLI升级后迁移，不重发未知请求或擅自换聊。
- 完善账号额度、重置预测、当前对话识别、CLI发现和损坏设置恢复；接入受限公开公告与观察数据，显示来源、截止时间和新鲜度，网络失败时安全降级，并保持公告、观察、Tibo 自述和真实额度确认分层；保留原图、音频、用户设置及Windows独立顶层跟随窗口。
- 聊天与模型维护消耗账号额度，额度显示本身不发模型请求。Worker关闭生命周期修复后的真实后端定向服务回归已通过；全量套件的平台夹具失败、旧完整UI检查未完成、Mac原生验证与用户体验验收分别记录。

## 0.3.51 — Bilingual interface and macOS window fixes, 2026-10-21

- Add persistent Simplified Chinese / English settings, bubbles, menus and dialogs, with layouts for longer English labels and reviewed built-in phrases.
- Preserve custom phrases, renamed characters, aliases, project and conversation names when changing language.
- Improve macOS Codex window identification, bounded native visibility recovery, smooth following and stacking after focus changes.
- Ignore delayed hidden snapshots from a previous remap; cancel pending recovery after a manual hide or foreground-app change and cap recovery attempts.
- Use `overflow: clip` on macOS to prevent focused bubble content from retaining an internal scroll crop.
- Preserve user settings, imported characters and original assets. See the [bilingual release notes](docs/releases/0.3.51.md).
- The bilingual interface was developed in the local 0.3.49 and 0.3.50 iterations; see the [0.3.50](docs/releases/0.3.50.md) and [0.3.49](docs/releases/0.3.49.md) notes.

## 0.3.48 — Cumulative update since 0.3.21, 2026-10-19

- Add split press/release interactions and five sound choices, including DSH Duck, with smoother rapid clicking and a held pose during drag. Sound assets have separate source/license scopes; see [audio provenance](docs/interaction-audio.md).
- Record locally observed accounts with independent five-hour reset countdowns and an in-widget reminder with four bounces; add conversation context, confirmed automatic/manual compaction totals and worktree uncommitted-file counts, with automatic detection and a manual list of up to 30 recent eligible conversations.
- Add two dragon-girl poses, Motion mirroring, Hugeicons controls, previous/next page arrows and SortableJS page ordering, visibility and startup-default settings.
- Add live size/opacity and independent bottom/side hiding previews; fix toolbar dismissal/access and Windows Codex discovery across installation volumes and user environments.
- Preserve settings, imported characters and valid selections. Native Mac CI covers both architectures; hands-on acceptance is separate.
- See the [complete Chinese and English release notes](docs/releases/0.3.48.md). The entries below retain the history of the local updates that make up this release.

## 0.3.48 — Louder bounce audio and balanced bubble press, 2026-10-19

- Increase interaction playback gain by 1.4× and add a further 1.6× boost to the default bubble-pop press, keeping the release at the shared level.
- Retain original PCM/sample bytes, pitch, timing, preset base gains, mute and cancellation. Widget playback and settings preview share the adjustment.
- Local runtime update only; installers remain 0.3.21.

## 0.3.47 — Simplified bubble-page ordering controls, 2026-10-19

- Remove the redundant up/down button pair from each bubble-page card. Retain SortableJS drag ordering, Hugeicons, visibility and default controls, and Alt + Arrow keyboard ordering on the handle.
- Update both source trees and the local runtime while preserving user preferences and characters. No installer or GitHub publication.

## 0.3.46 — Hugeicons page editor and SortableJS ordering, 2026-10-19

- Replace bubble-page glyphs, drag handles, default stars and move arrows with official Hugeicons Stroke Rounded SVGs.
- Use the official MIT-licensed SortableJS browser distribution for pointer-following cards, animated reordering and edge scrolling. Keep existing visibility, startup-default and keyboard controls; save only the completed order and restore saved order after failure.
- Bundle pinned third-party assets and full licenses locally. Update local runtime only; installers remain 0.3.21.

## 0.3.45 — Hugeicons controls and Motion mirroring, 2026-10-19

- Replace the custom perspective turn with the official MIT-licensed Motion Mini browser engine and a restrained planar mirror transition. Keep rapid reversal, breathing, press and corner movement independent.
- Replace toolbar glyphs with a consistent official Hugeicons Stroke Rounded subset and replace the ellipsis pager with separate previous/next arrows.
- Page navigation follows the configured visible order in both directions, wraps at either end and retains the independent startup default. Runtime assets are bundled locally with pinned versions, integrity records and full licenses.

## 0.3.44 — Live appearance, paper flip and bubble-page settings, 2026-10-19

- Preview widget size and opacity continuously while dragging, with one final preference save on release and cancellation restoring saved appearance.
- Animate character mirroring with a paper-like turn when crossing the display or host center line. Keep text readable and preserve drag, bounce and corner movement.
- Add a card-based bubble-page editor for visibility, drag ordering, keyboard reordering and direct default selection; retain at least one visible page and preserve all seven existing page functions.

## 0.3.43 — Live corner-peeking controls, 2026-10-19

- Hide the bottom and side hiding sliders while corner peeking is disabled. Preview the widget continuously while dragging, and persist the final value on release.
- Use 50% as the new bottom-hiding default and retain 100% for the side. Preserve existing saved values, including the user's current 50% bottom setting. Cancelled previews restore saved values without writing settings.

## 0.3.42 — Adjustable corner hiding, 2026-10-19

- Add separate bottom and side hiding controls below the corner-peeking switch. Each ranges from 0% to 200%, with 100% preserving the previous hiding amount and 0% exposing that edge.
- Apply changes when the slider is released, retain values while peeking is disabled, and scale both offsets with the widget. Keep continuous dragging, corner settling and fixed native window dimensions. Local runtime update only; installers remain 0.3.21.

## 0.3.41 — Local character names and order, 2026-10-19

- Rename the supplied poses to 小龙娘-托腮 (`frost-glass-cheek`) and 小龙娘-端庄 (`frost-glass-idle`), and list them first and second, followed by the original mint maid and lilac dragon maid.
- Retain stable IDs, image bytes, saved selections and names, and the cheek pose as the default and custom-character deletion fallback. Local update only; installers remain 0.3.21.

## 0.3.40 — Local character update, 2026-10-19

- Add the supplied final-1 and final-2 artwork as built-in characters: 霜璃·静候 (`frost-glass-idle`) and 霜璃·托腮 (`frost-glass-cheek`).
- Use 霜璃·托腮 for fresh settings and as the fallback after removing the selected custom character; retain existing valid selections and the original built-in characters.
- Keep both source platforms aligned, retain the original image bytes, and record their provenance separately from the existing CC BY 4.0 artwork grant. Local update only; installers remain 0.3.21.

## 0.3.39 — Local compatibility audit, 2026-10-19

- Fix Windows environment casing, minimal-PATH native helper discovery, and explicit Codex path handoff through Explorer/login items and Mac LaunchAgents.
- Reuse the installed app's trusted CLI resolver for plugin connection/removal, and support validated running Mac apps in moved locations.
- Close cancelled discovery workers, reject malformed app-server messages and handle pipe failures; invalidate obsolete window callbacks and verify final native parent relationships.
- Keep animations always enabled and preserve preferences. See the current [release scope and verification boundaries](docs/releases/0.3.48.md). This historical local update did not generate installers.

## 0.3.38 — Local animation update, 2026-10-19

- Remove the animation policy selector and always enable widget animations, regardless of system reduced-motion preferences or obsolete saved modes.
- Retain movement/hidden-state pauses, interaction behavior, sound preferences and the 0.3.37 Windows compatibility fixes. Local runtime update only; installers remain 0.3.21.

## 0.3.37 — Local compatibility update, 2026-10-19

- Identify the Windows desktop by process package identity and shared classification, independent of installation volume; preserve unknown results on identity-query failure.
- Discover a verified desktop's bundled CLI when an Explorer/login environment lacks terminal PATH, preserving explicit overrides and PATH precedence.
- Coordinate topmost through one lifecycle and verify the actual HWND flag; preserve child-window layering and the saved standalone preference.
- Add System, Always On and Off animation policies with an explanation of the effective state and consistent JavaScript/CSS behavior.
- This historical local update did not generate installers. Current [release scope and verification boundaries](docs/releases/0.3.48.md) cover the cumulative update.

## 0.3.36 — Local update, 2026-10-19

- Put Bubble Pop first and use it as the default; retain saved choices that remain available, while missing or removed sound IDs fall back to Bubble Pop.
- Remove Glass Tick, Soft Click, Mechanical, Digital and Pluck from the selectable catalog, and remove the original-version suffix from the classic chirp label.
- Add the original DSH duck press/release pair as a private local Windows payload. The five-choice local catalog is Bubble Pop, Soft Spring, Classic Chirp, Wood Tap and DSH Duck; source builds without the private payload disable the DSH choice with an installation message.
- Third-party redistribution permission for the DSH audio has not been obtained, so its bytes remain outside shared source and public packages. No GitHub publication or new installer; the latest generated installers remain 0.3.21.

## 0.3.35 — Local update, 2026-10-19

- Keep the compressed pose and press audio while dragging; rebound and play the matching release on drop, retaining the accepted animation and mute behavior.
- Add nine locally saved interaction sound presets and a mute-aware preview in settings, including the original chirp split into complementary press/release segments.
- Curate distinct CC0 Kenney source pairs, preserve notices and processing hashes, and guard preset changes against late decoding. Published installers remain 0.3.21.

## 0.3.34 — Local update, 2026-10-19

- Follow DSH's interruptible press/release transitions so rapid clicks continue from the displayed pose without restarting at rest or queuing delayed bounces.
- Add paired CC0 Kenney press/release sounds, audio-clock tail overlap, cached local decoding and cancellation of stale voices; preserve mute and the single account-reset chirp.
- Keep character/bubble motion synchronized, the toolbar fixed and drag/reduced-motion recovery intact. Published installers remain 0.3.21.

## 0.3.33 — Local update, 2026-10-19

- Add an 18 px interaction margin around the visible toolbar and a 600 ms dismissal grace period so the pointer can travel from the character to the buttons.
- Keep the toolbar open while crossing its expanded area or using the buttons; retain keyboard access and eventual dismissal without invisible mouse targets.
- Cover slow continuous pointer paths, gaps, all four button actions, reentry and dismissal timing in isolated renderer checks. Published installers remain 0.3.21.

## 0.3.32 — Local update, 2026-10-19

- Collapse the toolbar after mouse interaction ends, even when a clicked button retains focus. Keep it visible for keyboard focus and activation.
- Limit toolbar reveal to interactive hover regions; transparent outer padding no longer reveals it. Prevent an invisible toolbar from intercepting mouse input.
- Add isolated renderer regression checks for mouse focus, keyboard navigation, hidden hit testing, mirroring and scaling. Published installers remain 0.3.21.

## 0.3.31 — Local update, 2026-10-19

- Use the real profile nickname for automatic account labels; keep email, account names and handles as auxiliary data. Preserve manual aliases and clearly mark missing nicknames.
- Fetch scoped nickname and workspace metadata through bounded, read-only official profile requests after explicit local credential-read authorization; keep tokens out of records and output, and metadata out of public quota/MCP snapshots.
- Restore current-conversation detection by deduplicating Windows log path aliases using physical file identity and distributing the existing 4 MiB tail-read budget across recent log segments.
- Published installers remain 0.3.21; this update changes local runtime files only.

## 0.3.30 — Local update, 2026-10-19

- Automatically label observed accounts with an explicit display name when provided, otherwise their full email; show exact workspace names only when available.
- Preserve manual aliases, allow clearing an alias to restore automatic naming, and upgrade previous default numbered labels on observation.
- Keep identity display metadata local, separate it from public quota/MCP snapshots, and reject stale cross-account metadata. Published installers remain 0.3.21.

## 0.3.29 — Local update, 2026-10-19

- Replace system reset notifications with widget-only text and sound reminders.
- Bounce the character and bubble four times in one second for account resets; preserve normal interaction animations, mute, reduced motion and reminder deduplication.
- Published installers remain 0.3.21.

## 0.3.28 — Local update, 2026-10-19

- Add an account-management page with local aliases, observed five-hour windows, countdowns and per-account reset progress.
- Notify once when a recorded reset deadline arrives, including across restarts; respect reminder and sound settings and clearly mark historical estimates.
- Keep raw identities and credentials out of storage and account metadata out of MCP. Published installers remain 0.3.21.

## 0.3.27 — Local update, 2026-10-19

- Recognize older local conversations whose stored Windows paths use extended drive or UNC namespace aliases.
- Preserve lexical and real-path containment checks, and resolve the observed conversation ID independently of recent manual choices.
- Keep on-demand reads, settings and characters. No new installer or GitHub release.

## 0.3.26 — Local update, 2026-10-18

- Show the detected conversation name in parentheses in the automatic selector, with its project on a separate visible line.
- Use local project assignments and saved names when available, with workspace-directory fallback and full hover details.
- Keep six pages, four toolbar buttons, on-demand reads and preserved preferences. No new installer or GitHub release.

## 0.3.25 — Local update, 2026-10-18

- Show the conversation’s recorded context-compaction count on the second page, including automatic and manual compactions.
- Count committed compaction checkpoints once, restore counts from local history, and scan appended bytes on later clicks. Bounded partial scans show an explicit lower bound.
- Keep on-demand reads, remembered preferences and characters. No new installer or GitHub release.

## 0.3.24 — Local update, 2026-10-18

- Detect the visible local Codex conversation on demand using bounded window activity/route log metadata and the read-only conversation index.
- Default the second page to automatic detection, with the remembered manual selection available as a fallback. Show an unknown state when the window evidence is ambiguous.
- Add no background polling or IPC subscription; preserve preferences and characters. No new installer or GitHub release.

## 0.3.23 — Local update, 2026-10-18

- Move conversation status to the second bubble page, immediately after quota. Restore the four-button toolbar.
- Read on page entry or a click on the status bubble; preserve manual conversation selection and avoid background polling.

## 0.3.22 — Local update, 2026-10-18

- Add an on-demand conversation status button with a manual local conversation selector and a remembered selection.
- Show the selected conversation's context usage progress and the number of uncommitted files in its Git workspace, without background polling.
- Keep the existing pages, preferences and character library. No new installer or GitHub release is produced for this local update.

## 0.3.21 — 2026-10-18

Shared Windows and macOS release.

- Fix window-size growth during dragging at fractional Windows display scaling.
- Add optional display inside the Codex main window. Windows uses native child-window attachment to follow movement, minimization and restoration, with normal system occlusion by other windows and dialogs. macOS uses a separate window that follows Codex's bounds and visibility.
- Mirror the character when it crosses into the left half of the current screen or Codex window.
- Limit magnetic snapping to the two bottom corners. Add optional side-and-bottom peeking, continuous pointer-following dragging and interruptible settling after release.
- Add 3-second and 5-second bubble auto-collapse choices, with 5 seconds as the default. Preserve existing saved preferences, images and character libraries during upgrades.
- Expand isolated native, renderer and regression checks, and handle closed smoke-test output pipes.

Both window display and corner peeking are off by default. Manual Mac desktop acceptance is separate from CI. Installers remain without developer distribution certificates, and the Mac package is not Apple-notarized.

## 0.3.13 — 2026-10-17

- Keep filenames and edited character labels in the local UI, while returning fixed character labels from MCP tools.
- Add explicit local-plugin disconnection on both platforms. Windows offers it during interactive uninstallation; Mac includes a disconnection launcher in Applications. Other plugins and user data are retained.
- Read the Windows app-server handshake version from the application manifest, matching macOS and the shared release version.

## 0.3.12 — 2026-10-17

Initial public release, with one shared version for Windows and macOS.

- Windows x64 installer and macOS 13+ universal installer for Apple Silicon and Intel, including the application runtime and local plugin connector.
- Animated desktop companion with character images, themed thought bubbles, breathing and bounce interactions, and optional synthesized sound.
- Codex quota percentages, reset countdowns, multiple quota buckets, and configurable automatic refresh.
- Device-local token totals for today, the current week, and the most recently completed turn, with incomplete-record indicators.
- Current-user login helper and automatic widget startup and exit alongside Codex desktop.
- Saved position, edge snapping, mirrored layouts, size, opacity, always-on-top, click-through, custom phrases, and a local character library.
- Optional local MCP tools for widget status and fixed interaction controls, using the installer's bundled runtime.
- English and Simplified Chinese documentation; code under MIT and project-provided artwork under CC BY 4.0.

Validation includes Windows install/launch/control/MCP/upgrade/uninstall checks and universal Mac installation, startup, MCP, and launchd-helper checks on Apple Silicon and Intel macOS runners. Real-account and manual desktop-experience acceptance remains subject to broader user testing.

Installers currently lack developer distribution certificates; the Mac package is not Apple-notarized.
