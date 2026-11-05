/**
 * Keyword Radar — Constants & Default Configuration
 * https://github.com/serioos/Keyword-Radar
 */

export const EXTENSION_NAME = 'keyword_radar';
export const EXTENSION_DISPLAY_NAME = 'Keyword Radar';
export const METADATA_KEY = 'keyword_radar';

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    scanDelayMs: 160,
    minDraftChars: 1,
    defaultFilterMode: 'new-only', // 'new-only' | 'new-and-history' | 'all-active'
    showMutedBadges: true,
    muteBlocksRecursion: true,
    persistMuteAcrossSwipes: true,
    simulateRecursionAlways: false,
    uiMode: 'pill-bar', // 'pill-bar' | 'compact-icon'
    autoHideWhenEmpty: false,
    highlightInInput: true,
    hoverPreview: true,
    tokenWarnThreshold: 500,
    maxRecursionDepth: 6,
});

/**
 * Matches SillyTavern's `world_info_logic` in `public/scripts/world-info.js`
 */
export const SELECTIVE_LOGIC = Object.freeze({
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
});

export const SELECTIVE_LOGIC_LABELS = Object.freeze({
    [SELECTIVE_LOGIC.AND_ANY]: 'AND ANY (match ≥1 secondary)',
    [SELECTIVE_LOGIC.NOT_ALL]: 'NOT ALL (exclude if all secondary match)',
    [SELECTIVE_LOGIC.NOT_ANY]: 'NOT ANY (exclude if any secondary matches)',
    [SELECTIVE_LOGIC.AND_ALL]: 'AND ALL (match all secondary)',
});

export const SELECTIVE_LOGIC_SHORT = Object.freeze({
    [SELECTIVE_LOGIC.AND_ANY]: 'AND ANY',
    [SELECTIVE_LOGIC.NOT_ALL]: 'NOT ALL',
    [SELECTIVE_LOGIC.NOT_ANY]: 'NOT ANY',
    [SELECTIVE_LOGIC.AND_ALL]: 'AND ALL',
});

/**
 * Matches SillyTavern's `wi_anchor_position` in `public/scripts/world-info.js`
 */
export const WI_POSITION_LABELS = Object.freeze({
    0: 'Before Char Defs',
    1: 'After Char Defs',
    2: 'Before Author\'s Note',
    3: 'After Author\'s Note',
    4: '@ Depth',
    5: 'Top of Examples',
    6: 'Bottom of Examples',
    7: 'Outlet',
});

export const LORE_SCOPE_META = Object.freeze({
    character: {
        id: 'character',
        label: 'Character',
        short: 'Char',
        icon: 'fa-solid fa-user-shield',
    },
    chat: {
        id: 'chat',
        label: 'Chat',
        short: 'Chat',
        icon: 'fa-solid fa-comments',
    },
    persona: {
        id: 'persona',
        label: 'Persona',
        short: 'Persona',
        icon: 'fa-solid fa-id-badge',
    },
    global: {
        id: 'global',
        label: 'Global',
        short: 'Global',
        icon: 'fa-solid fa-globe',
    },
});

export const TRIGGER_STATUS = Object.freeze({
    NEW_DIRECT: 'new-direct',
    NEW_RECURSIVE: 'new-recursive',
    BOOSTED: 'boosted',
    MUTED: 'muted',
    MUTED_RECURSIVE: 'muted-recursive',
    ACTIVE_STICKY: 'active-sticky',
    ACTIVE_CONSTANT: 'active-constant',
    ACTIVE_HISTORY: 'active-history',
    ACTIVE_HISTORY_RECURSIVE: 'active-history-recursive',
});