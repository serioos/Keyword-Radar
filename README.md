# Keyword Radar — Pre-Send Lorebook Scanner & One-Turn Mute

A production-ready [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension (compatible with SillyTavern `1.12.0+` through `1.19.x`) that scans your draft message in real time as you type, shows a native-styled pre-flight radar of which Lorebook (World Info) entries your message is about to wake up, and lets you **one-turn mute** or **force-trigger** any entry with a single click.

<img width="974" height="554" alt="image" src="https://github.com/user-attachments/assets/018706e6-3cca-4ae6-b524-d8d29f19c529" />

<img width="697" height="683" alt="image" src="https://github.com/user-attachments/assets/6021a561-e460-4357-b90e-855eb13eda0d" />

---

## Features

- **Real-Time Draft Scanning** across all active Lorebooks (Global, Character, Chat, and Persona) with zero-overhead idling when no Lorebooks are active.
- **Full World Info Rule Fidelity**: supports standard keywords, secondary/optional filters (`AND ANY`, `NOT ALL`, `NOT ANY`, `AND ALL`), `/regex/flags`, whole-word & case-sensitivity rules, macro substitution (`{{user}}`, `{{char}}`), character/tag filters, generation-type triggers (`entry.triggers`), and timed effects (`sticky`, `cooldown`, `delay`).
- **New vs. Already-Active Distinction**: clearly separates entries *newly triggered* by your current draft from entries *already active* via chat history, constant status, or sticky timers.
- **Recursive Trigger Detection**: simulates multi-step recursion (`world_info_recursive`, `preventRecursion`, `excludeRecursion`, `delayUntilRecursion`) and traces the exact parent-to-child chain.
- **Native SillyTavern Theme & Accessibility Integration**: styled directly with SillyTavern's `--SmartTheme*` CSS variables (`--SmartThemeBlurTintColor`, `--SmartThemeBlurStrength`, `--SmartThemeBorderColor`, `color-mix()`) and native `.menu_button` / `.text_pole` controls, with both a **Reduce Animations** toggle and `prefers-reduced-motion` support.
- **Inline Draft Keyword Highlighting**: subtly highlights the exact triggering word(s) inside `#send_textarea` and emphasizes the linked word(s) when hovering over any radar pill.
- **Quick Entry Preview & Inspection**: hover or click any badge to inspect full entry content, primary/secondary keywords, trigger trace, probability, inclusion group competitors, budget warnings, and jump straight to **Edit in World Info** (with an option to either auto-expand the entry or just scroll to & highlight it).
- **One-Turn Mute & Extended Mutes**: click the mute icon on any badge to suppress it for the next generation only—without editing your Lorebook files—or right-click for **3 turns**, **5 turns**, **custom N turns**, or **remainder of this chat session** (persisted cleanly inside extension settings without touching chat files).
- **Swipe & Continue-Friendly Lifecycle**: keeps one-turn mutes (and boosts) active while swiping, regenerating, or continuing the AI's reply on the same turn, then automatically restores them as soon as you advance to the next turn.
- **Status-Aware Boost & Pre-Flight Manager**: click **Boost** (or press `Alt+B`) to inspect live trigger status (*Draft*, *Recursive via Parent*, *History*, *Constant*, *Sticky*, *Muted*, *Boosted*), toggle **"Hide already triggered"**, filter with quick status chips, preview recursive cascades before boosting, and boost or mute any entry in one place (including temporarily enabling disabled entries for one turn).
- **World Info Budget, Probability & Inclusion Group Indicators**: warns when active entries exceed your configured World Info token budget (`world_info_budget` / `world_info_budget_cap`), flags `<100%` probability rolls, and surfaces competing inclusion group members (including comma-separated multi-group entries).
- **Keyboard Shortcuts & Slash Commands**: `Alt+B` toggles the Boost Manager, `Alt+M` mutes or unmutes the trigger word(s) under your caret/selection, and STscript commands `/kr-mute`, `/kr-unmute`, `/kr-boost`, and `/kr-clear` support live autocomplete on SillyTavern `1.17+`.
- **Clean Lifecycle Management**: integrates with SillyTavern `1.17+` extension `clean` and `disable` hooks for clean data removal and teardown.

---

## Installation

### Recommended (SillyTavern Extension Installer)
1. Open SillyTavern.
2. Go to **Extensions** → **Install extension**.
3. Paste the repository URL:
   ```
   https://github.com/serioos/Keyword-Radar
   ```
4. Click **Install** and reload SillyTavern if prompted.

### Manual Installation
Clone or extract this repository into your SillyTavern third-party extensions folder:
```bash
cd SillyTavern/data/<your-user-handle>/extensions/
git clone https://github.com/serioos/Keyword-Radar.git
```
Restart or refresh SillyTavern.

---

## Slash Commands & Shortcuts

| Shortcut / Command | Action |
| :--- | :--- |
| `Alt + B` | Open or close the Boost & Pre-Flight Manager modal |
| `Alt + M` | Mute (1 turn) or unmute the triggering entry(ies) under your caret or selection inside `#send_textarea` |
| `/kr-mute <title, UID, or world.UID>` | Mute an entry for 1 turn (supports `turns=N` or `session=true`) |
| `/kr-unmute <title, UID, or world.UID>` | Unmute a previously muted entry |
| `/kr-boost <title, UID, or world.UID>` | Force-trigger an entry for the next turn |
| `/kr-clear` | Clear all active mutes and manual boosts in the current chat |

---

## Extension Settings

Open **Extensions → Keyword Radar** in SillyTavern to configure:

| Setting | Default | Description |
| :--- | :--- | :--- |
| **Enable Keyword Radar** | On | Master toggle for scanning, UI bar, and generation interception. |
| **Hide Radar bar when there are no new draft triggers** | Off | Keeps the chat input clean until a word in your draft triggers an entry (or you boost one). |
| **Reduce Animations** | Off | Disables transitions, pop-in animations, and backdrop blur for maximum snappiness. |
| **Typing Scan Delay** | `180 ms` | Debounce delay (`50–1000 ms`) while typing in `#send_textarea`. |
| **Default Radar Bar Filter** | Newly triggered by draft | Show only draft-triggered (+ recursive & boosted) entries, or all active entries including history/constant/sticky. |
| **Radar Bar Display Style** | Always-visible pill bar | Choose between an always-visible pill bar or a compact collapsible radar indicator. |
| **Muting a parent blocks recursive children** | On | Prevents a muted parent entry from waking up recursive children. When disabled, affected recursive children are preserved via force-activation. |
| **Keep one-turn mutes & boosts across swipes** | On | Keeps active turn overrides intact during `swipe`, `regenerate`, and `continue` on the same turn, then restores automatically on the next turn. |
| **Auto-expand entry on "Edit in World Info"** | On | When unchecked, scrolls to and highlights the entry in World Info without opening its drawer. |
| **Highlight triggering keywords in input** | On | Renders a non-intrusive scroll-synced highlight layer over `#send_textarea`. |
| **Show entry preview popover on hover** | On | Opens the full entry preview popover on badge hover (clicking always opens a pinned popover). |
| **Show World Info budget & overflow warnings** | On | Flags when active entries exceed your configured World Info token budget. |
| **Enable keyboard shortcuts** | On | Enables `Alt+B` and `Alt+M` shortcuts. |
| **Show Lorebook name / token cost on pills** | On | Controls whether each pill shows its source Lorebook name and token estimate. |

---

## Running Tests

Keyword Radar has zero runtime npm dependencies. To run the automated test suite locally (Node.js 18+):

```bash
npm test
```

---

## License

MIT License — see [LICENSE](./LICENSE).
