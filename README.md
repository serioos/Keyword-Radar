# Keyword Radar — Pre-Send Lorebook Scanner & One-Turn Mute

**Keyword Radar 1.2.1** is a real-time pre-flight Lorebook (World Info) scanner and single-click suppression/boost extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern).

While typing a reply in SillyTavern, it is easy to casually use a common word—like *"shadow"*, *"crown"*, or *"tavern"*—without realizing it matches a trigger keyword for an 800-token Lorebook entry (plus recursive child entries) that has nothing to do with your current scene.

**Keyword Radar** scans your draft in real time as you type, displays a non-intrusive radar bar right above the chat input box, highlights the exact triggering words in your draft, and lets you mute (or force-trigger) any entry for the upcoming turn with a single click.

---

## ✨ Key Features

### 1. Real-Time Draft Scanning
- **Multi-Scope Lorebook Coverage:** Scans active World Info across **Character** (Primary and Auxiliary), **Chat**, **Persona**, and **Global** scopes.
- **SillyTavern-Authentic Matching:** Mirrors primary and secondary key logic (`AND ANY`, `NOT ALL`, `NOT ANY`, `AND ALL`), native `/regex/flags`, whole-word boundaries, per-entry matching options, character name/tag filters, generation triggers when exposed by the active context, content decorators, and inclusion-group score pruning.
- **New vs. Already-Active Differential:** Clearly distinguishes between entries that are **newly woken up by your draft** (`+N new`) versus entries that are **already active** from recent chat history, sticky timers, or constant status.
- **Recursive Trigger Graph:** Detects multi-step recursive cascades (`Parent Entry -> Child Entry`) and displays exact parent-to-child provenance.

### 2. Non-Intrusive Radar UI & Input Highlighting
- **Compact Pill Bar:** Displays each detected entry as an interactive badge showing its title, Lorebook source, matched keyword hint, recursive chain count, and estimated token cost.
- **Token Impact Summary:** Shows the total token cost of newly triggered entries (`+XXX tok`) and warns when your draft exceeds your configured token threshold.
- **In-Place Input Highlighting:** Subtly underlines matched keywords directly inside `#send_textarea` without interfering with typing, cursor position, or undo history. Hovering over any badge spotlights the exact word(s) in your message that triggered it.

### 3. Quick Entry Preview, Inspection & Inline Editing
- **Hover / Click Inspection Popover:** Preview an entry's full text, primary/secondary keywords, and exact activation reason (direct draft match, recursive parent chain, sticky timer, or history depth).
- **Quick-Edit Modal:** Permanently edit an entry's keywords, optional filter logic, or content right from the chat bar—or jump straight to the entry inside SillyTavern's World Info Editor.

### 4. One-Turn Mute (Temporary Suppression)
- **Single-Click Suppression:** Click the mute icon on any badge to suppress that entry **for the next generation only** without altering your Lorebook files.
- **Swipe-Friendly Lifecycle:** Keeps your one-turn mute active if you swipe or regenerate the AI's reply on that turn, and automatically restores the entry to normal as soon as you send your next message.
- **Recursive Blocking:** Muting a parent entry automatically prevents its recursive child entries from firing (configurable in settings).
- **Extended Mute Context Menu:** Right-click any badge to mute an entry for **1, 3, 5, or 10 turns**, or for the **remainder of the current chat session**.

### 5. One-Turn Manual Boost (Force-Trigger)
- Click the **Boost** button in the radar bar to search across all active Lorebooks and force-inject any entry into the next turn—even if you didn't type its keyword in your message.

---

## 📦 Installation

1. Open SillyTavern and go to **Extensions** (`stacked blocks icon`) &rarr; **Install extension**.
2. Paste the repository URL:
   ```text
   https://github.com/serioos/Keyword-Radar
   ```
3. Enable **Keyword Radar** in the Extensions menu.

## Compatibility and prediction limits

- Reviewed against the official SillyTavern **1.19.0** release source and extension-manifest guidance. The manifest declares **1.15.0** as the minimum client version because the mutable `WORLDINFO_SCAN_DONE` hook used for reliable Stage 2 suppression is available from that release line.
- The extension follows the current nested scan-event payload and removes muted entries from the authoritative `activated.entries` `Map`, not merely from diagnostic arrays.
- The radar is a pre-send prediction, not a replacement for SillyTavern's World Info engine. It includes scan-enabled extension prompts through the current core registry/resolver when available, but it cannot perfectly predict probabilistic entries, weighted-random inclusion-group winners, prompt-budget truncation, or generation trigger values that are not exposed to the extension before send. For those cases, the live prompt remains authoritative.
- Minimum-activation depth expansion is modeled for non-recursive scans when the current settings permit it. Recursive scans use a separate engine loop and are approximated by the radar's recursive trigger graph.

## Development checks

Run the scanner and lifecycle regression tests from the extension directory:

```bash
node --experimental-default-type=module tests/scanner.test.js
```

The suite covers matching semantics, current World Info settings, core-compatible timed-effect hashing, decorators, generation triggers, depth-zero and extension-prompt scanning, inclusion-group scoring, minimum-activation depth, Stage 1 boost mutation, current Stage 2 `Map` suppression, per-loop scan diagnostics, and idempotent generation cleanup / swipe lifecycle behaviour.


### 1.2.1 log-driven lifecycle hardening

- Coalesces closely spaced message/generation lifecycle refreshes into one fresh lore snapshot and scan.
- Makes generation cleanup idempotent when SillyTavern sends more than one terminal notification for a generation; one-turn overrides are finalized only once.
- Resets per-generation action diagnostics at generation start so reports cannot carry stale boosts/mutes forward.
- Records SillyTavern's Stage 2 scan-loop state (`current`, `next`, `loopCount`), recursion-delay level, and budget to distinguish expected recursive passes from abnormal repeats.
- Makes the chat-session mute action visibly toggle to **Unmute for Chat** in the popover and removes redundant session-mute actions from the context menu while already active; closes the popover after state changes.
- Keeps current settings separate from unknown legacy preference names in diagnostic reports (`legacySettingsIgnored`) without deleting or rewriting user preferences.
- Prevents an entry from retaining a swipe-persisted boost when it is muted (and vice versa), and reports deleted-prompt restoration counts separately for mutes and boosts.
