# Keyword Radar — Pre-Send Lorebook Scanner & One-Turn Mute

**Keyword Radar** is a real-time pre-flight Lorebook (World Info) scanner and single-click suppression/boost extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern).

While typing a reply in SillyTavern, it is easy to casually use a common word—like *"shadow"*, *"crown"*, or *"tavern"*—without realizing it matches a trigger keyword for an 800-token Lorebook entry (plus recursive child entries) that has nothing to do with your current scene.

**Keyword Radar** scans your draft in real time as you type, displays a non-intrusive radar bar right above the chat input box, highlights the exact triggering words in your draft, and lets you mute (or force-trigger) any entry for the upcoming turn with a single click.

---

<img width="994" height="496" alt="image" src="https://github.com/user-attachments/assets/475edf5b-84ec-4acd-8486-c99062436ce6" />

---

## ✨ Key Features

### 1. Real-Time Draft Scanning
- **Multi-Scope Lorebook Coverage:** Automatically scans all active Lorebooks across **Character** (Primary, Additional/Aux, and Group member books), **Chat**, **Persona**, and **Global** World Info.
- **SillyTavern-Authentic Matching:** Supports primary keys, secondary/optional filters (`AND ANY`, `NOT ALL`, `NOT ANY`, `AND ALL`), `/regex/flags` keys, whole-word vs. substring matching, case sensitivity, per-entry scan depth, and character filters.
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
