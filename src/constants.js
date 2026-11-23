/**
 * Keyword Radar — Constants & Default Settings
 */

export const EXTENSION_NAME = 'keyword_radar';
export const EXTENSION_DISPLAY_NAME = 'Keyword Radar';
export const EXTENSION_VERSION = '1.4.0';
export const LOG_PREFIX = '[Keyword Radar]';

export const WI_LOGIC = Object.freeze({
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
});

export const WI_LOGIC_LABELS = Object.freeze({
    [WI_LOGIC.AND_ANY]: 'AND ANY',
    [WI_LOGIC.NOT_ALL]: 'NOT ALL',
    [WI_LOGIC.NOT_ANY]: 'NOT ANY',
    [WI_LOGIC.AND_ALL]: 'AND ALL',
});

export const WI_POSITION_LABELS = Object.freeze({
    0: 'Before Char Defs',
    1: 'After Char Defs',
    2: 'Before Author\'s Note',
    3: 'After Author\'s Note',
    4: 'In-Chat @ Depth',
    5: 'Before Example Msgs',
    6: 'After Example Msgs',
    7: 'Outlet',
});

export const ACTIVATION_SOURCE = Object.freeze({
    DRAFT: 'draft',
    RECURSIVE_DRAFT: 'recursive_draft',
    BOOSTED: 'boosted',
    HISTORY: 'history',
    RECURSIVE_HISTORY: 'recursive_history',
    CONSTANT: 'constant',
    STICKY: 'sticky',
});

export const FILTER_MODE = Object.freeze({
    DRAFT_ONLY: 'draft_only',
    ALL_ACTIVE: 'all_active',
});

export const DISPLAY_MODE = Object.freeze({
    BAR: 'bar',
    COMPACT: 'compact',
});

export const MUTE_MODE = Object.freeze({
    TURNS: 'turns',
    SESSION: 'session',
});

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    debounceMs: 180,
    filterMode: FILTER_MODE.DRAFT_ONLY,
    muteBlocksRecursiveChildren: true,
    keepMuteOnSwipe: true,
    displayMode: DISPLAY_MODE.BAR,
    autoHideWhenNoNewTriggers: false,
    reduceAnimations: false,
    highlightDraftKeywords: true,
    hoverPreview: true,
    showTokenEstimate: true,
    showLorebookName: true,
    showBudgetWarning: true,
    expandOnEditInWorldInfo: true,
    enableHotkeys: true,
    boostHideAlreadyTriggered: false,
    maxVisibleBadges: 24,
    chatMutes: {},
});
