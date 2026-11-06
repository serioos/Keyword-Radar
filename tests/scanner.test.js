/**
 * Keyword Radar — Unit Tests for Scanner Engine & Multi-Stage Mute Lifecycle
 * Run with: node tests/scanner.test.js
 */

import assert from 'node:assert/strict';
import { SELECTIVE_LOGIC, TRIGGER_STATUS } from '../src/constants.js';
import {
    buildDepthBuffer,
    calculateEntryGroupScore,
    evaluateEntryKeysAgainstBuffer,
    matchSingleKeyInText,
    passesCharacterFilter,
    runPreSendRadarScan,
} from '../src/scanner.js';
import { RadarStateManager } from '../src/state.js';
import { makeEntryKey } from '../src/utils.js';
import {
    computeWorldInfoEntryHash,
    extractTimedEffects,
    normalizeWorldInfoEntry,
    normalizeWorldInfoGlobalSettings,
    parseWorldInfoDecorators,
    resolveCharacterFilename,
} from '../src/st-bridge.js';

function createMockEntry(overrides = {}) {
    const world = overrides.world || 'EldoriaLore';
    const uid = overrides.uid ?? 1;
    return {
        uid,
        entryKey: makeEntryKey(world, uid),
        world,
        scope: overrides.scope || 'character',
        key: overrides.key || ['shadow'],
        keysecondary: overrides.keysecondary || [],
        comment: overrides.comment || `Entry ${uid}`,
        content: overrides.content || 'Lore content about the shadow.',
        constant: Boolean(overrides.constant),
        selective: overrides.selective !== undefined ? overrides.selective : true,
        selectiveLogic: overrides.selectiveLogic ?? SELECTIVE_LOGIC.AND_ANY,
        order: overrides.order ?? 100,
        position: 0,
        depth: 4,
        disable: Boolean(overrides.disable),
        excludeRecursion: Boolean(overrides.excludeRecursion),
        preventRecursion: Boolean(overrides.preventRecursion),
        delayUntilRecursion: Number(overrides.delayUntilRecursion || 0),
        scanDepth: overrides.scanDepth ?? null,
        caseSensitive: overrides.caseSensitive ?? null,
        matchWholeWords: overrides.matchWholeWords ?? null,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        characterFilter: overrides.characterFilter || null,
    };
}

// 0.1 Character filename resolution must use the current utils.js export and normalize any extension.
{
    const fromCoreUtils = resolveCharacterFilename(3, { avatar: 'fallback.png' }, {
        utils: { getCharaFilename: (id) => id === 3 ? 'active-character' : null },
    });
    assert.equal(fromCoreUtils, 'active-character');
    assert.equal(
        resolveCharacterFilename(3, { avatar: 'folder\\hero.webp' }, {}),
        'hero',
        'Avatar fallback should remove the actual file extension, not only .png',
    );
}

// 1. Test Whole-Word vs Substring Matching
{
    const wholeWordRes = matchSingleKeyInText('She walked into the shadowy hall.', 'shadow', {
        caseSensitive: false,
        matchWholeWords: true,
        collectSpans: true,
    });
    assert.equal(wholeWordRes.matched, false, 'Whole-word "shadow" should not match "shadowy"');

    const exactWordRes = matchSingleKeyInText('A figure stepped out of the shadow.', 'shadow', {
        caseSensitive: false,
        matchWholeWords: true,
        collectSpans: true,
    });
    assert.equal(exactWordRes.matched, true, 'Whole-word "shadow" should match "shadow."');
    assert.equal(exactWordRes.spans.length, 1);
    assert.equal(exactWordRes.spans[0].text, 'shadow');
}

// 2. Test Regex Key Matching (/pattern/flags)
{
    const rxRes = matchSingleKeyInText('The ancient crown of kings gleamed.', '/cr[o0]wn\\s+of\\s+kings/i', {
        caseSensitive: true,
        matchWholeWords: true,
        collectSpans: true,
    });
    assert.equal(rxRes.matched, true, 'Regex key should match pattern in draft');
    assert.equal(rxRes.spans[0].text, 'crown of kings');
}

// 2.1 Regex flags are authoritative, independent of global matching settings.
{
    const caseSensitiveRegex = matchSingleKeyInText('THE KING ARRIVES', '/king/', {
        caseSensitive: false,
        matchWholeWords: false,
        collectSpans: true,
    });
    assert.equal(caseSensitiveRegex.matched, false, 'Regex keys without /i must remain case-sensitive');

    const caseInsensitiveRegex = matchSingleKeyInText('THE KING ARRIVES', '/king/i', {
        caseSensitive: true,
        matchWholeWords: true,
        collectSpans: true,
    });
    assert.equal(caseInsensitiveRegex.matched, true, 'Regex /i must remain case-insensitive even when global setting is strict');
    assert.equal(caseInsensitiveRegex.spans[0].text, 'KING');
}

// 2.2 Punctuation must use the same whole-word boundary rule as SillyTavern.
{
    assert.equal(
        matchSingleKeyInText('The code (C++) is compiled.', 'C++', {
            caseSensitive: false,
            matchWholeWords: true,
            collectSpans: true,
        }).matched,
        true,
        'Punctuation-containing single tokens should use ST whole-word boundaries',
    );
    assert.equal(
        matchSingleKeyInText('notfoo-bar is present', 'foo-bar', {
            caseSensitive: false,
            matchWholeWords: true,
            collectSpans: true,
        }).matched,
        false,
        'Whole-word matching must not treat punctuation-containing tokens as free substrings',
    );
    assert.equal(
        matchSingleKeyInText('A keeper watches the tavern, north door.', 'tavern, north', {
            caseSensitive: false,
            matchWholeWords: true,
            collectSpans: true,
        }).matched,
        true,
        'Multi-word phrases should use literal substring matching even with punctuation',
    );
}

// 3. Test Selective Logic (AND_ANY, NOT_ANY, AND_ALL, NOT_ALL)
{
    const entryAndAny = createMockEntry({
        key: ['tavern'],
        keysecondary: ['ale', 'bard'],
        selective: true,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
    });

    assert.equal(
        evaluateEntryKeysAgainstBuffer(entryAndAny, 'I enter the tavern.', 'I enter the tavern.', {
            caseSensitive: false,
            matchWholeWords: true,
        }).triggered,
        false,
        'AND_ANY should fail when no secondary key matches',
    );

    assert.equal(
        evaluateEntryKeysAgainstBuffer(entryAndAny, 'I enter the tavern and order ale.', 'I enter the tavern and order ale.', {
            caseSensitive: false,
            matchWholeWords: true,
        }).triggered,
        true,
        'AND_ANY should pass when at least 1 secondary key matches',
    );

    const entryNotAny = createMockEntry({
        key: ['crown'],
        keysecondary: ['museum', 'replica'],
        selective: true,
        selectiveLogic: SELECTIVE_LOGIC.NOT_ANY,
    });

    assert.equal(
        evaluateEntryKeysAgainstBuffer(entryNotAny, 'He wore the golden crown.', 'He wore the golden crown.', {
            caseSensitive: false,
            matchWholeWords: true,
        }).triggered,
        true,
        'NOT_ANY should pass when no excluded secondary key is present',
    );

    assert.equal(
        evaluateEntryKeysAgainstBuffer(entryNotAny, 'He saw the crown in the museum.', 'He saw the crown in the museum.', {
            caseSensitive: false,
            matchWholeWords: true,
        }).triggered,
        false,
        'NOT_ANY should block trigger when an excluded secondary key is present',
    );
}

// 4. Test New vs. Already-Active Distinction & Recursive Cascade + Parent Mute Blocking
{
    const historyEntry = createMockEntry({
        uid: 10,
        comment: 'Silverkeep Castle',
        key: ['silverkeep'],
        content: 'The fortress of Silverkeep stands in the north.',
    });

    const draftDirectEntry = createMockEntry({
        uid: 20,
        comment: 'The Obsidian Crown',
        key: ['crown'],
        content: 'Forged by Malakor during the First Eclipse.',
    });

    const recursiveChildEntry = createMockEntry({
        uid: 30,
        comment: 'Malakor the Undying',
        key: ['malakor'],
        content: 'Arch-necromancer of the First Eclipse.',
    });

    const baseScanParams = {
        draftText: 'I reach for the heavy crown on the altar.',
        entries: [historyEntry, draftDirectEntry, recursiveChildEntry],
        globalSettings: {
            scanDepth: 2,
            recursive: true,
            maxRecursionSteps: 4,
            caseSensitive: false,
            matchWholeWords: true,
            includeNames: true,
        },
        scanContext: {
            name1: 'User',
            name2: 'Narrator',
            chatMessages: [
                { name: 'Narrator', mes: 'Welcome to the halls of Silverkeep.', is_user: false },
            ],
            totalChatLength: 1,
        },
        mutedKeys: new Set(),
        boostedEntriesMap: new Map(),
        muteBlocksRecursion: true,
        simulateRecursionAlways: false,
        maxRecursionDepth: 5,
        tokenCounterFn: () => 250,
    };

    const scan1 = runPreSendRadarScan(baseScanParams);

    const histResult = scan1.resultsMap.get(historyEntry.entryKey);
    const directResult = scan1.resultsMap.get(draftDirectEntry.entryKey);
    const recResult = scan1.resultsMap.get(recursiveChildEntry.entryKey);

    assert.equal(histResult.status, TRIGGER_STATUS.ACTIVE_HISTORY, 'Silverkeep should be marked ACTIVE_HISTORY');
    assert.equal(histResult.isNewFromDraft, false);

    assert.equal(directResult.status, TRIGGER_STATUS.NEW_DIRECT, 'Obsidian Crown should be marked NEW_DIRECT');
    assert.equal(directResult.isNewFromDraft, true);
    assert.equal(directResult.triggeredChildren.length, 1, 'Obsidian Crown should list Malakor as recursive child');

    assert.equal(recResult.status, TRIGGER_STATUS.NEW_RECURSIVE, 'Malakor should be marked NEW_RECURSIVE');
    assert.equal(recResult.isRecursive, true);
    assert.equal(scan1.summary.newDraftTokens, 500, '2 new entries * 250 tokens = 500 new draft tokens');

    // Now mute the parent ("The Obsidian Crown") and verify both parent and recursive child are suppressed
    const scanMuted = runPreSendRadarScan({
        ...baseScanParams,
        mutedKeys: new Set([draftDirectEntry.entryKey]),
    });

    assert.equal(
        scanMuted.resultsMap.get(draftDirectEntry.entryKey).status,
        TRIGGER_STATUS.MUTED,
        'Parent entry should be MUTED',
    );
    assert.equal(
        scanMuted.resultsMap.get(recursiveChildEntry.entryKey).status,
        TRIGGER_STATUS.MUTED_RECURSIVE,
        'Child entry should be MUTED_RECURSIVE when muteBlocksRecursion is true',
    );
    assert.equal(scanMuted.summary.newDraftTokens, 0, 'New draft tokens should drop to 0 when parent is muted');
    assert.equal(scanMuted.summary.mutedSavedTokens, 500, 'Muted saved tokens should equal 500');
}


// 4.1 Current SillyTavern settings getter values and zero values are preserved.
{
    const normalized = normalizeWorldInfoGlobalSettings({
        world_info_depth: 0,
        world_info_recursive: false,
        world_info_max_recursion_steps: 0,
        world_info_case_sensitive: true,
        world_info_match_whole_words: false,
        world_info_include_names: false,
        world_info_budget: 0,
        world_info_budget_cap: 0,
        world_info_min_activations: 3,
        world_info_min_activations_depth_max: 8,
        world_info_use_group_scoring: true,
        world_info_character_strategy: 2,
    });
    assert.equal(normalized.scanDepth, 0, 'A configured zero scan depth must not be replaced by a fallback');
    assert.equal(normalized.recursive, false);
    assert.equal(normalized.matchWholeWords, false);
    assert.equal(normalized.budget, 0, 'A configured zero budget must not be replaced by a fallback');
    assert.equal(normalized.minActivations, 3);
    assert.equal(normalized.minActivationsDepthMax, 8);
    assert.equal(normalized.useGroupScoring, true);
    assert.equal(normalized.characterStrategy, 2);

    const defaults = normalizeWorldInfoGlobalSettings({});
    assert.equal(defaults.recursive, false, 'Current SillyTavern default recursion is disabled');
    assert.equal(defaults.matchWholeWords, false, 'Current SillyTavern default whole-word matching is disabled');
}

// 4.2 Current SillyTavern top-level timedWorldInfo buckets are parsed by world.uid.
{
    const timedEntry = createMockEntry({ uid: 81, world: 'TimedBook' });
    timedEntry.sticky = 3;
    timedEntry.cooldown = 2;
    const chatMeta = {
        timedWorldInfo: {
            sticky: {
                'TimedBook.81': { hash: 1234, start: 4, end: 7, protected: false },
            },
            cooldown: {
                'TimedBook.81': { hash: 1234, start: 4, end: 8, protected: false },
            },
        },
    };

    const active = extractTimedEffects(chatMeta, 5, [timedEntry], 1);
    assert.equal(active.sticky.has(timedEntry.entryKey), true, 'Sticky should be active at upcoming chat index 6');
    assert.equal(active.cooldown.has(timedEntry.entryKey), true, 'Cooldown should suppress at upcoming chat index 6');
    assert.equal(active.stickyTurnsLeft.get(timedEntry.entryKey), 1);

    const expired = extractTimedEffects(chatMeta, 6, [timedEntry], 1);
    assert.equal(expired.sticky.has(timedEntry.entryKey), false, 'Effects ending at the upcoming chat index must be expired');

    const protectedEffect = extractTimedEffects({
        timedWorldInfo: {
            sticky: { 'TimedBook.81': { hash: 1234, start: 5, end: 8, protected: true } },
        },
    }, 5, [timedEntry], 0);
    assert.equal(protectedEffect.sticky.has(timedEntry.entryKey), true, 'Protected effects survive a chat that has not advanced');

    timedEntry.sticky = 0;
    const staleEffect = extractTimedEffects(chatMeta, 5, [timedEntry], 1);
    assert.equal(staleEffect.sticky.has(timedEntry.entryKey), false, 'Entries without sticky configured must not keep stale timers active');
}

// 4.22 Depth zero must not scan character auxiliaries or scan-enabled extension prompts.
{
    assert.equal(buildDepthBuffer([], null, 0, false), '', 'World Info depth zero has no scan buffer');
    assert.equal(buildDepthBuffer([], null, 1, false), '\x01', 'A positive empty buffer still carries ST separator marker');

    const first = createMockEntry({ uid: 76, key: ['injected-only'], constant: true });
    const second = createMockEntry({ uid: 77, key: ['not-injected'], constant: true });
    first.group = second.group = 'depth-zero-group';
    const scan = runPreSendRadarScan({
        draftText: '',
        entries: [first, second],
        globalSettings: {
            scanDepth: 0,
            recursive: false,
            maxRecursionSteps: 0,
            caseSensitive: false,
            matchWholeWords: false,
            includeNames: false,
            useGroupScoring: true,
        },
        scanContext: {
            chatMessages: [],
            totalChatLength: 0,
            generationTrigger: 'normal',
            extraScanFields: { injectionPrompts: 'injected-only' },
        },
        mutedKeys: new Set(),
        boostedEntriesMap: new Map(),
        tokenCounterFn: () => 1,
    });
    assert.equal(scan.resultsMap.has(first.entryKey), true);
    assert.equal(scan.resultsMap.has(second.entryKey), true, 'An injection prompt must not be scanned at depth zero');
}

// 4.22b Positive scan depth includes scan-enabled extension prompt text in group scoring.
{
    const first = createMockEntry({ uid: 761, key: ['injected-only'], constant: true });
    const second = createMockEntry({ uid: 762, key: ['not-injected'], constant: true });
    first.group = second.group = 'injection-group';
    const scan = runPreSendRadarScan({
        draftText: '',
        entries: [first, second],
        globalSettings: {
            scanDepth: 1,
            recursive: false,
            maxRecursionSteps: 0,
            caseSensitive: false,
            matchWholeWords: false,
            includeNames: false,
            useGroupScoring: true,
        },
        scanContext: {
            chatMessages: [],
            totalChatLength: 0,
            generationTrigger: 'normal',
            extraScanFields: { injectionPrompts: 'injected-only' },
        },
        mutedKeys: new Set(),
        boostedEntriesMap: new Map(),
        tokenCounterFn: () => 1,
    });
    assert.equal(scan.resultsMap.has(first.entryKey), true);
    assert.equal(scan.resultsMap.has(second.entryKey), false, 'The lower-scoring group member should lose to the injection-matched entry');
}

// 4.22c Timed effect matching uses the current core entry hash, including parsed decorators.
{
    const raw = {
        uid: 82,
        key: ['hash-key'],
        content: '@@activate\nLore body',
        order: 100,
    };
    const currentHash = computeWorldInfoEntryHash(raw, 'HashBook');
    const entry = normalizeWorldInfoEntry(raw, 82, 'HashBook', 'global');
    entry.hash = currentHash;
    entry.sticky = 2;
    const metadata = {
        timedWorldInfo: {
            sticky: {
                'HashBook.82': { hash: currentHash, start: 0, end: 3, protected: false },
            },
        },
    };
    assert.equal(extractTimedEffects(metadata, 1, [entry], 1).sticky.has(entry.entryKey), true);

    const edited = { ...raw, content: '@@activate\nEdited lore body' };
    entry.hash = computeWorldInfoEntryHash(edited, 'HashBook');
    assert.notEqual(entry.hash, currentHash, 'Editing entry content must change the core-compatible hash');
    assert.equal(extractTimedEffects(metadata, 1, [entry], 1).sticky.has(entry.entryKey), false, 'A stale sticky timer must not follow an edited entry');
}

// 4.23 Minimum activations can expand global scan depth when recursion is disabled.
{
    const deepEntry = createMockEntry({ uid: 78, key: ['deep-rune'] });
    const scan = runPreSendRadarScan({
        draftText: 'A quiet greeting.',
        entries: [deepEntry],
        globalSettings: {
            scanDepth: 1,
            minActivations: 1,
            minActivationsDepthMax: 0,
            recursive: false,
            maxRecursionSteps: 0,
            caseSensitive: false,
            matchWholeWords: false,
            includeNames: false,
            useGroupScoring: false,
        },
        scanContext: {
            chatMessages: [
                { name: 'Narrator', mes: 'The hidden deep-rune glows.', is_user: false },
                { name: 'User', mes: 'The corridor is quiet.', is_user: true },
                { name: 'Narrator', mes: 'Dust settles.', is_user: false },
            ],
            totalChatLength: 3,
            generationTrigger: 'normal',
        },
        mutedKeys: new Set(),
        boostedEntriesMap: new Map(),
        tokenCounterFn: () => 1,
    });
    assert.equal(scan.resultsMap.has(deepEntry.entryKey), true, 'The scan should deepen until it reaches the minimum activation count');
    assert.equal(scan.resultsMap.get(deepEntry.entryKey).status, TRIGGER_STATUS.ACTIVE_HISTORY);
}

// 4.23b Core disables minimum-activation depth expansion when recursion steps are configured.
{
    const deepEntry = createMockEntry({ uid: 780, key: ['deep-rune'] });
    const scan = runPreSendRadarScan({
        draftText: '',
        entries: [deepEntry],
        globalSettings: {
            scanDepth: 1,
            minActivations: 1,
            minActivationsDepthMax: 5,
            recursive: false,
            maxRecursionSteps: 2,
            caseSensitive: false,
            matchWholeWords: false,
            includeNames: false,
            useGroupScoring: false,
        },
        scanContext: {
            chatMessages: [
                { name: 'Narrator', mes: 'The hidden deep-rune glows.', is_user: false },
                { name: 'User', mes: 'A quiet greeting.', is_user: true },
            ],
            totalChatLength: 2,
            generationTrigger: 'normal',
        },
        mutedKeys: new Set(),
        boostedEntriesMap: new Map(),
        tokenCounterFn: () => 1,
    });
    assert.equal(scan.resultsMap.has(deepEntry.entryKey), false);
}

// 4.24 Inclusion group scoring uses current primary/secondary score rules.
{
    const matchOpts = { caseSensitive: false, matchWholeWords: false };
    const high = createMockEntry({
        uid: 79,
        key: ['dragon'],
        keysecondary: ['storm', 'moon'],
        selective: true,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
    });
    const low = createMockEntry({
        uid: 80,
        key: ['dragon'],
        keysecondary: ['eclipse', 'sun'],
        selective: false,
    });
    assert.equal(calculateEntryGroupScore(high, 'dragon storm moon', matchOpts), 3);
    assert.equal(calculateEntryGroupScore(low, 'dragon storm moon', matchOpts), 1);

    high.group = 'mythic-group';
    low.group = 'mythic-group';
    const grouped = runPreSendRadarScan({
        draftText: 'dragon storm moon',
        entries: [high, low],
        globalSettings: {
            scanDepth: 2,
            recursive: false,
            maxRecursionSteps: 0,
            caseSensitive: false,
            matchWholeWords: false,
            includeNames: false,
            useGroupScoring: true,
        },
        scanContext: { chatMessages: [], totalChatLength: 0, generationTrigger: 'normal' },
        mutedKeys: new Set(),
        boostedEntriesMap: new Map(),
        tokenCounterFn: () => 1,
    });
    assert.equal(grouped.resultsMap.has(high.entryKey), true);
    assert.equal(grouped.resultsMap.has(low.entryKey), false, 'The lower-scoring candidate should be pruned from its inclusion group');
}

// 4.25 Current character filters are independent AND constraints and use tag IDs.
{
    const entry = createMockEntry({
        characterFilter: { isExclude: false, names: ['Aria'], tags: ['tag-42'] },
    });
    assert.equal(
        passesCharacterFilter(entry, {
            characterAvatar: 'Aria',
            characterFilename: 'Aria',
            characterTags: ['tag-42'],
            characterTagsAvailable: true,
        }),
        true,
        'An included character name and included tag should both pass',
    );
    assert.equal(
        passesCharacterFilter(entry, {
            characterAvatar: 'Aria',
            characterFilename: 'Aria',
            characterTags: ['tag-99'],
            characterTagsAvailable: true,
        }),
        false,
        'Matching the name must not bypass a non-matching configured tag',
    );
    assert.equal(
        passesCharacterFilter(entry, {
            characterAvatar: 'Other',
            characterFilename: 'Other',
            characterTags: ['tag-42'],
            characterTagsAvailable: true,
        }),
        false,
        'Matching the tag must not bypass a non-matching configured character name',
    );
    assert.equal(
        passesCharacterFilter(entry, {
            characterAvatar: 'Other',
            characterFilename: 'Other',
            characterTags: undefined,
            characterTagsAvailable: false,
        }),
        false,
        'Unavailable tag maps should skip the tag constraint but still enforce the name constraint',
    );

    const tagOnlyEntry = createMockEntry({
        characterFilter: { isExclude: false, names: [], tags: ['tag-42'] },
    });
    assert.equal(
        passesCharacterFilter(tagOnlyEntry, { characterTags: undefined, characterTagsAvailable: false }),
        true,
        'SillyTavern skips tag filtering when it cannot resolve a tag-map key',
    );
    assert.equal(
        passesCharacterFilter(tagOnlyEntry, { characterTags: [], characterTagsAvailable: true }),
        false,
        'An available but empty tag list must fail an include-tag filter',
    );
    assert.equal(
        passesCharacterFilter(entry, { characterFilename: 'aria', characterTags: ['tag-42'], characterTagsAvailable: true }),
        false,
        'Character filename matching follows SillyTavern exact-case inclusion semantics',
    );
}

// 4.26 Generation-specific trigger filters must match the current generation type.
{
    const normalEntry = createMockEntry({ uid: 82, key: ['signal'] });
    normalEntry.triggers = ['normal'];
    const impersonationOnlyEntry = createMockEntry({ uid: 83, key: ['signal'] });
    impersonationOnlyEntry.triggers = ['impersonate'];
    const scan = runPreSendRadarScan({
        draftText: 'signal',
        entries: [normalEntry, impersonationOnlyEntry],
        globalSettings: {
            scanDepth: 2,
            recursive: false,
            maxRecursionSteps: 0,
            caseSensitive: false,
            matchWholeWords: false,
            includeNames: false,
        },
        scanContext: { chatMessages: [], totalChatLength: 0, generationTrigger: 'normal' },
        mutedKeys: new Set(),
        boostedEntriesMap: new Map(),
        tokenCounterFn: () => 1,
    });
    assert.equal(scan.resultsMap.has(normalEntry.entryKey), true);
    assert.equal(scan.resultsMap.has(impersonationOnlyEntry.entryKey), false);
}

// 4.3 Stage 2 must mutate the current nested WORLDINFO_SCAN_DONE event payload.
{
    const state = new RadarStateManager();
    const muted = createMockEntry({
        world: 'StageTwoBook',
        uid: 55,
        comment: 'Muted recursive lore',
        content: 'This content must not be injected into the prompt.',
    });
    state.setMute(muted, 'one-turn', 1);

    const item = {
        world: muted.world,
        uid: muted.uid,
        comment: muted.comment,
        content: muted.content,
    };
    const payload = {
        state: { current: 1, next: 2, loopCount: 0 },
        new: { all: [item], successful: [item] },
        activated: {
            entries: new Map([[`${muted.world}.${muted.uid}`, item]]),
            text: `Keep this.\n\n${muted.content}`,
        },
        sortedEntries: [item],
        budget: { current: 25, overflowed: false },
    };

    const result = state.applyToScanDone(payload);
    assert.equal(result.removed.length, 1, 'A muted item should be reported once even though it appears in several nested collections');
    assert.equal(payload.new.all.length, 0);
    assert.equal(payload.new.successful.length, 0);
    assert.equal(payload.activated.entries.size, 0, 'The authoritative current SillyTavern activation Map must be mutated');
    assert.equal(payload.sortedEntries.length, 0);
    assert.equal(payload.activated.text.includes(muted.content), false, 'The mutable activated text should be scrubbed before core consumes it');
    assert.equal(payload.activated.text.includes('Keep this.'), true);
}


// 4.26B Stage 2 diagnostics preserve SillyTavern's per-loop state for recursion debugging.
{
    const state = new RadarStateManager();
    state.applyToScanDone({
        state: { current: 2, next: 3, loopCount: 4 },
        new: { all: [], successful: [] },
        activated: { entries: new Map(), text: '' },
        sortedEntries: [],
        recursionDelay: { currentLevel: 1, availableLevels: [0, 1, 2] },
        budget: { current: 17, overflowed: false },
        timedEffects: {},
    });
    const diagnostic = state.diagnosticLogs.at(-1);
    assert.equal(diagnostic.event, 'STAGE2_WORLDINFO_SCAN_DONE');
    assert.deepEqual(diagnostic.details.scanState, { current: 2, next: 3, loopCount: 4 });
    assert.deepEqual(diagnostic.details.recursionDelay, { currentLevel: 1, availableLevels: [0, 1, 2] });
    assert.deepEqual(diagnostic.details.budget, { current: 17, overflowed: false });
}

// 4.27 Current World Info decorators are parsed only from the content prefix.
{
    const parsed = parseWorldInfoDecorators('@@activate\n@@dont_activate\nThe body starts here.');
    assert.deepEqual(parsed.decorators, ['@@activate', '@@dont_activate']);
    assert.equal(parsed.content, 'The body starts here.');

    const escaped = parseWorldInfoDecorators('@@@activate\nThe escaped token is literal.');
    assert.deepEqual(escaped.decorators, []);
    assert.equal(escaped.content, 'The escaped token is literal.');

    const unknownOnly = parseWorldInfoDecorators('@@unknown\n@@another');
    assert.deepEqual(unknownOnly.decorators, []);
    assert.equal(unknownOnly.content, '@@unknown\n@@another', 'Core retains the source content if no non-decorator line is reached');

    const normalized = normalizeWorldInfoEntry({ uid: 1, content: '@@activate\nInjected lore.' }, 1, 'DecoratorBook');
    assert.deepEqual(normalized.decorators, ['@@activate']);
    assert.equal(normalized.content, 'Injected lore.');
}

// 4.28 @@activate must not bypass SillyTavern's delay-until-recursion gate.
{
    const forced = createMockEntry({ uid: 84 });
    forced.decorators = ['@@activate'];
    const delayedForced = createMockEntry({ uid: 85, delayUntilRecursion: 1 });
    delayedForced.decorators = ['@@activate'];
    const delayedConstant = createMockEntry({ uid: 86, delayUntilRecursion: 1, constant: true });
    const scan = runPreSendRadarScan({
        draftText: 'A quiet draft.',
        entries: [forced, delayedForced, delayedConstant],
        globalSettings: {
            scanDepth: 2,
            recursive: false,
            maxRecursionSteps: 0,
            caseSensitive: false,
            matchWholeWords: false,
            includeNames: false,
        },
        scanContext: { chatMessages: [], totalChatLength: 0, generationTrigger: 'normal' },
        mutedKeys: new Set(),
        boostedEntriesMap: new Map(),
        tokenCounterFn: () => 1,
    });
    assert.equal(scan.resultsMap.has(forced.entryKey), true, '@@activate should force an otherwise eligible entry');
    assert.equal(scan.resultsMap.has(delayedForced.entryKey), false, '@@activate must not skip delayUntilRecursion');
    assert.equal(scan.resultsMap.has(delayedConstant.entryKey), false, 'Constant entries are also delayed until the configured recursion level');
}


// 4.29 Stage 1 boosts must clear delayUntilRecursion because SillyTavern checks it before constant.
{
    const state = new RadarStateManager();
    const delayed = createMockEntry({
        world: 'BoostBook',
        uid: 87,
        delayUntilRecursion: 3,
        constant: false,
    });
    state.addBoost(delayed, 1);
    const payload = {
        globalLore: [],
        characterLore: [{
            world: delayed.world,
            uid: delayed.uid,
            comment: delayed.comment,
            content: delayed.content,
            key: delayed.key,
            delayUntilRecursion: 3,
            constant: false,
        }],
        chatLore: [],
        personaLore: [],
    };
    const result = state.applyToLoadedEntries(payload);
    assert.equal(result.added.length, 1);
    assert.equal(payload.characterLore[0].constant, true);
    assert.equal(payload.characterLore[0].delayUntilRecursion, 0, 'Boosted entry should no longer be blocked by delayUntilRecursion');
    assert.equal(payload.characterLore[0].delay, 0, 'Boosted entry should not remain blocked by its initial chat delay');

    const personaState = new RadarStateManager();
    const missingPersonaEntry = createMockEntry({
        world: 'PersonaBoostBook',
        uid: 88,
        scope: 'persona',
    });
    personaState.addBoost(missingPersonaEntry, 1);
    const missingPayload = { globalLore: [], characterLore: [], chatLore: [], personaLore: [] };
    const missingResult = personaState.applyToLoadedEntries(missingPayload);
    assert.equal(missingResult.added.length, 1);
    assert.equal(missingPayload.personaLore.length, 1, 'A missing boosted entry should be inserted into its original scope');
    assert.equal(missingPayload.globalLore.length, 0, 'A persona boost must not be misclassified as global lore');
}

// 5. Test Stage 1 (WORLDINFO_ENTRIES_LOADED), Stage 4 (Outgoing Prompt Scrubber) & Diagnostic Report
{
    const state = new RadarStateManager();
    const crownEntry = createMockEntry({
        world: 'EldoriaLore',
        uid: 20,
        comment: 'The Obsidian Crown',
        key: ['crown'],
        content: 'Forged by Malakor during the First Eclipse.',
    });

    state.setMute(crownEntry, 'one-turn', 1);
    assert.equal(state.isMuted(crownEntry.entryKey), true);

    // Simulate MESSAGE_SENT firing right before World Info generation
    state.onUserMessageSent();
    assert.equal(
        state.isMuted(crownEntry.entryKey),
        true,
        'Mute must remain active after MESSAGE_SENT so the outgoing generation can suppress it',
    );

    // Stage 1: Simulate SillyTavern emitting WORLDINFO_ENTRIES_LOADED
    const loadedPayload = {
        globalLore: [],
        characterLore: [
            { world: 'EldoriaLore', uid: 10, comment: 'Silverkeep', content: 'North fortress.' },
            { world: 'EldoriaLore', uid: 20, comment: 'The Obsidian Crown', content: 'Forged by Malakor during the First Eclipse.' },
        ],
        chatLore: [],
        personaLore: [],
    };

    const stage1Res = state.applyToLoadedEntries(loadedPayload);
    assert.equal(stage1Res.removed.length, 1, 'Stage 1 should remove the muted entry from characterLore before scanning');
    assert.equal(loadedPayload.characterLore.length, 1, 'characterLore should only have 1 remaining entry');
    assert.equal(loadedPayload.characterLore[0].uid, 10);

    // Stage 4: Simulate outgoing prompt verification & fallback scrubbing if an entry ever leaked
    const leakedPromptPayload = {
        chat: [
            { role: 'system', content: 'North fortress.\nForged by Malakor during the First Eclipse.' },
            { role: 'user', content: 'I pick up the crown.' },
        ],
    };

    const stage4Res = state.verifyAndScrubOutgoingPrompt(leakedPromptPayload, 'CHAT_COMPLETION_PROMPT_READY');
    assert.equal(stage4Res.leakedAndScrubbed.length, 1, 'Stage 4 should detect and scrub any leaked muted entry content');
    assert.equal(
        leakedPromptPayload.chat[0].content.includes('Forged by Malakor'),
        false,
        'Muted entry content must be completely scrubbed from outgoing prompt',
    );

    // Diagnostic report check
    const report = state.buildDiagnosticReport({ testRun: true });
    assert.ok(Array.isArray(report.eventTrace), 'Diagnostic report should include eventTrace');
    assert.ok(report.eventTrace.length >= 3, 'Diagnostic report should have recorded MUTE_ARMED, STAGE1, and STAGE4 events');
}

// 5.1 Replacing a conflicting swipe override triggers one render, not an intermediate stale render.
{
    let notifications = 0;
    const state = new RadarStateManager(() => notifications++);
    const entry = createMockEntry({ world: 'RenderBook', uid: 900, comment: 'Render target' });

    state.addBoost(entry, 1);
    assert.equal(notifications, 1);
    state.setMute(entry, 'one-turn', 1);
    assert.equal(notifications, 2, 'Replacing a boost with a mute should notify once after the new state is ready');
    state.addBoost(entry, 1);
    assert.equal(notifications, 3, 'Replacing a mute with a boost should notify once after the new state is ready');
}

// 6. Generation terminal events are idempotent and diagnostics do not carry stale actions.
{
    const originalWindow = globalThis.window;
    const mockContext = {
        chat: [{ is_user: true, is_system: false, mes: 'A test prompt.' }],
        extensionSettings: {
            keyword_radar: {
                persistMuteAcrossSwipes: true,
                scanDelay: 350,
                highlightInput: true,
            },
        },
        chatMetadata: {},
    };
    globalThis.window = { SillyTavern: { getContext: () => mockContext } };

    try {
        const state = new RadarStateManager();
        const boosted = createMockEntry({ world: 'LifecycleBook', uid: 901, comment: 'Lifecycle boost' });
        state.addBoost(boosted, 1);
        state.onGenerationStarted('normal', false);
        state.applyToLoadedEntries({ globalLore: [], characterLore: [], chatLore: [], personaLore: [] });
        assert.equal(state.boosts.get(boosted.entryKey).consumedInGeneration, true);

        const firstTerminal = state.onGenerationStoppedOrEnded('GENERATION_STOPPED');
        assert.equal(firstTerminal, true);
        assert.equal(state.boosts.has(boosted.entryKey), false, 'A consumed one-turn boost should leave active state once finalized');
        assert.equal(state.lastTurnSwipeMemory?.boosts.has(boosted.entryKey), true, 'The boost should remain available for a swipe of the same turn');

        const memoryBeforeDuplicate = Array.from(state.lastTurnSwipeMemory.boosts.keys());
        const secondTerminal = state.onGenerationStoppedOrEnded('GENERATION_ENDED');
        assert.equal(secondTerminal, false, 'A second terminal event for the same generation must be ignored');
        assert.deepEqual(Array.from(state.lastTurnSwipeMemory.boosts.keys()), memoryBeforeDuplicate, 'Duplicate terminal events must not mutate swipe memory');
        assert.equal(state.diagnosticLogs.at(-1).event, 'GENERATION_TERMINAL_DUPLICATE_IGNORED');

        state.lastGenerationActions = [{ entryKey: boosted.entryKey, action: 'boosted' }];
        state.onGenerationStarted('normal', false);
        assert.deepEqual(state.lastGenerationActions, [], 'A new generation must not inherit previous-generation action diagnostics');

        const report = state.buildDiagnosticReport();
        assert.equal(report.extension, 'Keyword Radar v1.2.1');
        assert.equal(report.settings.scanDelayMs, 160, 'The current setting schema should be reported separately from stale preferences');
        assert.equal(report.settings.scanDelay, undefined);
        assert.ok(report.legacySettingsIgnored.includes('scanDelay'));
        assert.ok(report.legacySettingsIgnored.includes('highlightInput'));

        // Changing a swipe-persisted boost into a mute must clear the conflicting
        // boost snapshot too, otherwise a swipe can try to force-activate a muted entry.
        state.setMute(boosted, 'one-turn', 1);
        assert.equal(state.lastTurnSwipeMemory?.boosts.has(boosted.entryKey) || false, false);
        assert.equal(state.mutes.has(boosted.entryKey), true);

        // Verify deletion diagnostics distinguish mute restoration from boost restoration.
        const deletionState = new RadarStateManager();
        const muteEntry = createMockEntry({ world: 'InspectBook', uid: 902, comment: 'Inspect mute' });
        const boostEntry = createMockEntry({ world: 'InspectBook', uid: 903, comment: 'Inspect boost' });
        deletionState.setMute(muteEntry, 'one-turn', 1);
        deletionState.addBoost(boostEntry, 1);
        deletionState.onGenerationStarted('normal', false);
        deletionState.applyToLoadedEntries({ globalLore: [], characterLore: [], chatLore: [], personaLore: [] });
        deletionState.onGenerationStoppedOrEnded('GENERATION_ENDED');
        mockContext.chat = [];
        deletionState.onMessageDeleted();
        const deletionLog = deletionState.diagnosticLogs.at(-1);
        assert.equal(deletionLog.details.restoredOneTurnMutesAfterInspectAbort, true);
        assert.equal(deletionLog.details.restoredOneTurnBoostsAfterInspectAbort, true);
        assert.equal(deletionLog.details.restoredOneTurnOverridesAfterInspectAbort, true);
        assert.equal(deletionLog.details.restoredMutesCount, 1);
        assert.equal(deletionLog.details.restoredBoostsCount, 1);
        assert.equal(deletionState.mutes.has(muteEntry.entryKey), true);
        assert.equal(deletionState.boosts.has(boostEntry.entryKey), true);

        const conflictState = new RadarStateManager();
        const conflictEntry = createMockEntry({ world: 'ConflictBook', uid: 904, comment: 'Mute then boost' });
        conflictState.setMute(conflictEntry, 'one-turn', 1);
        conflictState.onGenerationStarted('normal', false);
        conflictState.applyToLoadedEntries({ globalLore: [], characterLore: [], chatLore: [], personaLore: [] });
        conflictState.onGenerationStoppedOrEnded('GENERATION_ENDED');
        assert.equal(conflictState.lastTurnSwipeMemory?.mutes.has(conflictEntry.entryKey), true);
        conflictState.addBoost(conflictEntry, 1);
        assert.equal(conflictState.lastTurnSwipeMemory?.mutes.has(conflictEntry.entryKey) || false, false);
        assert.equal(conflictState.boosts.has(conflictEntry.entryKey), true);
    } finally {
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
    }
}

console.log('✅ All Keyword Radar scanner & multi-stage mute unit tests passed!');
