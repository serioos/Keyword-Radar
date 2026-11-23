import assert from 'node:assert/strict';
import test from 'node:test';

import { ACTIVATION_SOURCE, DEFAULT_SETTINGS, MUTE_MODE, WI_LOGIC } from '../src/constants.js';
import { createInterceptor } from '../src/interceptor.js';
import { evaluateEntryKeywords, findKeywordSpans, matchKeyword } from '../src/matcher.js';
import { findMatchesAtCaret, previewRecursiveCascade, scanDraftAgainstLorebooks } from '../src/scanner.js';
import { createRadarState } from '../src/state.js';
import { getEntryKey, scoreBoostEntry } from '../src/utils.js';

// ---------------------------------------------------------------------------
// 1. Matcher Engine Tests
// ---------------------------------------------------------------------------

test('matchKeyword handles plaintext, case sensitivity, whole words, and regex triggers', () => {
    assert.equal(matchKeyword('A shadow fell across the hall.', 'shadow', {}, {}), true);
    assert.equal(matchKeyword('A shadow fell across the hall.', 'Shadow', { caseSensitive: true }, {}), false);
    assert.equal(matchKeyword('The overshadowed valley', 'shadow', { matchWholeWords: true }, {}), false);
    assert.equal(matchKeyword('A shadow, cold and still.', 'shadow', { matchWholeWords: true }, {}), true);
    assert.equal(matchKeyword('The crimson crown gleamed', '/crimson\\s+crown/i', {}, {}), true);
    assert.equal(matchKeyword('The silver crown gleamed', '/crimson\\s+crown/i', {}, {}), false);
});

test('findKeywordSpans returns accurate character offsets for highlighting', () => {
    const draft = 'I walk into the Tavern and spot a shadow near the tavern bar.';
    const spans = findKeywordSpans(draft, 'tavern', { matchWholeWords: true }, {});
    assert.equal(spans.length, 2);
    assert.equal(draft.slice(spans[0].start, spans[0].end), 'Tavern');
    assert.equal(draft.slice(spans[1].start, spans[1].end), 'tavern');

    const regexSpans = findKeywordSpans(draft, '/sh[a-z]+w/i', {}, {});
    assert.equal(regexSpans.length, 1);
    assert.equal(draft.slice(regexSpans[0].start, regexSpans[0].end), 'shadow');
});

test('evaluateEntryKeywords enforces all four SillyTavern secondary selectiveLogic modes', () => {
    const base = { key: ['crown'], selective: true, keysecondary: ['king', 'throne'] };

    assert.equal(evaluateEntryKeywords({ ...base, selectiveLogic: WI_LOGIC.AND_ANY }, 'The crown of the king').matched, true);
    assert.equal(evaluateEntryKeywords({ ...base, selectiveLogic: WI_LOGIC.AND_ANY }, 'A broken crown').matched, false);

    assert.equal(evaluateEntryKeywords({ ...base, selectiveLogic: WI_LOGIC.AND_ALL }, 'The king took the crown to the throne').matched, true);
    assert.equal(evaluateEntryKeywords({ ...base, selectiveLogic: WI_LOGIC.AND_ALL }, 'The king wore the crown').matched, false);

    assert.equal(evaluateEntryKeywords({ ...base, selectiveLogic: WI_LOGIC.NOT_ANY }, 'A dusty crown').matched, true);
    assert.equal(evaluateEntryKeywords({ ...base, selectiveLogic: WI_LOGIC.NOT_ANY }, 'The king touched the crown').matched, false);

    assert.equal(evaluateEntryKeywords({ ...base, selectiveLogic: WI_LOGIC.NOT_ALL }, 'The king wore the crown').matched, true);
    assert.equal(evaluateEntryKeywords({ ...base, selectiveLogic: WI_LOGIC.NOT_ALL }, 'The king wore the crown on his throne').matched, false);
});

// ---------------------------------------------------------------------------
// 2. Scanner Tests
// ---------------------------------------------------------------------------

test('scanDraftAgainstLorebooks distinguishes draft, recursive draft, history, constant, and sticky', () => {
    const entries = [
        { uid: 1, world: 'Fantasy World', comment: 'Shadow Guild', key: ['shadow'], content: 'The Shadow Guild secretly answers to the Obsidian Citadel.', hash: 1001 },
        { uid: 2, world: 'Fantasy World', comment: 'Obsidian Citadel', key: ['Obsidian Citadel'], content: 'An ancient fortress floating above the rift.', hash: 1002 },
        { uid: 3, world: 'Fantasy World', comment: 'Tavern Regulars', key: ['tavern'], content: 'Barkeep Mara pours spiced ale.', hash: 1003 },
        { uid: 4, world: 'Global Rules', comment: 'Tone Guide', constant: true, key: [], content: 'Maintain dark fantasy atmosphere.', hash: 1004 },
        { uid: 5, world: 'Character Lore', comment: 'Active Curse', key: ['curse'], sticky: 3, content: 'The frost curse lingers for 3 turns.', hash: 1005 },
    ];

    const chatMessages = [
        { name: 'User', mes: 'We entered the tavern at dusk.', is_user: true },
        { name: 'Char', mes: 'Mara waves from behind the counter.', is_user: false },
    ];

    const timedWorldInfo = {
        sticky: { 'Character Lore.5': { hash: 1005, start: 1, end: 5, protected: false } },
        cooldown: {},
    };

    const result = scanDraftAgainstLorebooks({
        entries,
        chatMessages,
        draftText: 'I whisper about the shadow watching us.',
        timedWorldInfo,
        scanConfig: { scanDepth: 3, recursive: true, maxRecursionSteps: 4, includeNames: true },
    });

    const byUid = new Map(result.matches.map((m) => [m.uid, m]));
    assert.equal(byUid.get(1)?.source, ACTIVATION_SOURCE.DRAFT);
    assert.equal(byUid.get(2)?.source, ACTIVATION_SOURCE.RECURSIVE_DRAFT);
    assert.equal(byUid.get(2)?.triggeredBy[0]?.title, 'Shadow Guild');
    assert.equal(byUid.get(3)?.source, ACTIVATION_SOURCE.HISTORY);
    assert.equal(byUid.get(4)?.source, ACTIVATION_SOURCE.CONSTANT);
    assert.equal(byUid.get(5)?.source, ACTIVATION_SOURCE.STICKY);
    assert.equal(result.summary.activeNewCount, 2);
});

test('muting parent suppresses recursive child when muteBlocksRecursiveChildren is true, or preserves it when false', () => {
    const entries = [
        { uid: 10, world: 'Lore', comment: 'Parent', key: ['crown'], content: 'Mentioning the hidden vault.' },
        { uid: 11, world: 'Lore', comment: 'Child', key: ['hidden vault'], content: 'Vault lore content.' },
    ];
    const effectiveMutes = new Map([[getEntryKey(entries[0]), { mode: MUTE_MODE.TURNS, remainingTurns: 1 }]]);

    const blocked = scanDraftAgainstLorebooks({
        entries,
        chatMessages: [],
        draftText: 'He reached for the crown.',
        scanConfig: { scanDepth: 2, recursive: true },
        effectiveMutes,
        muteBlocksRecursiveChildren: true,
    });
    assert.equal(blocked.matches.find((m) => m.uid === 11)?.suppressedByParentMute, true);

    const preserved = scanDraftAgainstLorebooks({
        entries,
        chatMessages: [],
        draftText: 'He reached for the crown.',
        scanConfig: { scanDepth: 2, recursive: true },
        effectiveMutes,
        muteBlocksRecursiveChildren: false,
    });
    assert.equal(preserved.preservedRecursiveChildren.length, 1);
});

// ---------------------------------------------------------------------------
// 3. v1.1 & v1.2 Feature Tests
// ---------------------------------------------------------------------------

test('scanner flags World Info budget overflow respecting order and ignoreBudget', () => {
    const entries = [
        { uid: 1, world: 'W', comment: 'High Priority', key: ['sword'], order: 200, content: 'A'.repeat(240) },
        { uid: 2, world: 'W', comment: 'Low Priority', key: ['sword'], order: 50, content: 'B'.repeat(240) },
        { uid: 3, world: 'W', comment: 'Always Fits', key: ['sword'], order: 10, ignoreBudget: true, content: 'C'.repeat(240) },
    ];

    const res = scanDraftAgainstLorebooks({
        entries,
        chatMessages: [],
        draftText: 'I draw my sword.',
        scanConfig: { scanDepth: 2, budgetTokens: 100 },
        tokenCache: new Map([['W.1', 60], ['W.2', 60], ['W.3', 60]]),
    });

    const byUid = new Map(res.matches.map((m) => [m.uid, m]));
    assert.equal(byUid.get(1)?.budgetOverflow, false);
    assert.equal(byUid.get(2)?.budgetOverflow, true);
    assert.equal(byUid.get(3)?.budgetOverflow, false);
    assert.equal(res.summary.budgetExceeded, true);
    assert.equal(res.summary.overflowCount, 1);
});

test('scanner surfaces probability (<100%) and competing inclusion group metadata', () => {
    const entries = [
        { uid: 1, world: 'W', comment: 'Weather Rain', key: ['sky'], useProbability: true, probability: 40, group: 'weather', content: 'Rain falls.' },
        { uid: 2, world: 'W', comment: 'Weather Snow', key: ['sky'], useProbability: true, probability: 100, group: 'weather', content: 'Snow falls.' },
    ];

    const res = scanDraftAgainstLorebooks({
        entries,
        chatMessages: [],
        draftText: 'I look up at the sky.',
        scanConfig: { scanDepth: 2 },
    });

    assert.equal(res.matches.find((m) => m.uid === 1)?.probability, 40);
    assert.deepEqual(res.matches.find((m) => m.uid === 1)?.groupCompetitors, ['Weather Snow']);
});

test('previewRecursiveCascade predicts chained children before manual boosting', () => {
    const entries = [
        { uid: 1, world: 'W', comment: 'Arcane Gate', key: ['gate'], content: 'Leads straight to the Astral Sea.' },
        { uid: 2, world: 'W', comment: 'Astral Sea', key: ['Astral Sea'], content: 'Home of the Star Leviathan.' },
        { uid: 3, world: 'W', comment: 'Star Leviathan', key: ['Star Leviathan'], content: 'An ancient cosmic guardian.' },
    ];

    const preview = previewRecursiveCascade(entries[0], entries, new Set(), { recursive: true, maxRecursionSteps: 5 });
    assert.deepEqual(preview.children.map((c) => c.title), ['Astral Sea', 'Star Leviathan']);
});

test('scoreBoostEntry ranks fuzzy title matches above keyword, world, and content matches', () => {
    const byTitle = { comment: 'Grimbarrow (Village)', world: 'Morvalis', key: ['village'], content: 'A quiet hamlet.' };
    const byFuzzyTitle = { comment: 'Grimholt (City Capital)', world: 'Morvalis', key: ['capital'], content: 'Capital city.' };
    const byKeyword = { comment: 'Northern Trade Road', world: 'Morvalis', key: ['grimbarrow'], content: 'Connects towns.' };
    const byContent = { comment: 'Old Innkeeper', world: 'Morvalis', key: ['inn'], content: 'Born in Grimbarrow long ago.' };

    const sTitle = scoreBoostEntry(byTitle, 'grimbarrow');
    const sKeyword = scoreBoostEntry(byKeyword, 'grimbarrow');
    const sContent = scoreBoostEntry(byContent, 'grimbarrow');

    assert.ok(sTitle > sKeyword, 'Title match must outrank keyword match');
    assert.ok(sKeyword > sContent, 'Keyword match must outrank content-only match');
    assert.ok(sContent > 0, 'Content match should still be found');

    // Fuzzy subsequence on entry title ("gmbw" -> "Grimbarrow")
    const sFuzzy = scoreBoostEntry(byTitle, 'gmbw');
    const sOther = scoreBoostEntry(byFuzzyTitle, 'gmbw');
    assert.ok(sFuzzy > 10000, 'Fuzzy title match should land in title tier');
    assert.equal(sOther, 0);
});

test('DEFAULT_SETTINGS includes v1.1 and v1.2 toggles', () => {
    assert.equal(DEFAULT_SETTINGS.expandOnEditInWorldInfo, true);
    assert.equal(DEFAULT_SETTINGS.autoHideWhenNoNewTriggers, false);
    assert.equal(DEFAULT_SETTINGS.showBudgetWarning, true);
    assert.equal(DEFAULT_SETTINGS.enableHotkeys, true);
});

// ---------------------------------------------------------------------------
// 4. Swipe-Friendly Lifecycle & Interceptor Tests
// ---------------------------------------------------------------------------

test('one-turn mute persists across swipes on the same turn and auto-restores on the next turn', async () => {
    const state = createRadarState({ keepMuteOnSwipe: true, muteBlocksRecursiveChildren: true });
    const entry = { uid: 1, world: 'Main', comment: 'Shadow', content: 'Shadow lore', disable: false };

    const interceptor = createInterceptor(state, {
        fetchAllEntries: async () => [entry],
        emitForceActivate: async () => {},
    });

    state.muteEntry(entry, { mode: MUTE_MODE.TURNS, turns: 1 });

    const chatTurn1 = [{ is_user: true, mes: 'Shadow appears' }];
    await interceptor.handleGenerateInterceptor(chatTurn1, 8192, () => {}, 'normal');
    const loaded1 = { globalLore: [{ ...entry }], characterLore: [], chatLore: [], personaLore: [] };
    interceptor.handleWorldInfoEntriesLoaded(loaded1);
    assert.equal(loaded1.globalLore[0].disable, true);

    const chatTurn1Swipe = [...chatTurn1, { is_user: false, mes: 'AI reply v1' }];
    await interceptor.handleGenerateInterceptor(chatTurn1Swipe, 8192, () => {}, 'swipe');
    const loadedSwipe = { globalLore: [{ ...entry }], characterLore: [], chatLore: [], personaLore: [] };
    interceptor.handleWorldInfoEntriesLoaded(loadedSwipe);
    assert.equal(loadedSwipe.globalLore[0].disable, true);

    const chatTurn2 = [...chatTurn1Swipe, { is_user: true, mes: 'Next turn shadow' }];
    await interceptor.handleGenerateInterceptor(chatTurn2, 8192, () => {}, 'normal');
    const loaded2 = { globalLore: [{ ...entry }], characterLore: [], chatLore: [], personaLore: [] };
    interceptor.handleWorldInfoEntriesLoaded(loaded2);
    assert.equal(loaded2.globalLore[0].disable, false);
});

test('multi-turn mute (3 turns), session mute, and one-turn manual boost lifecycle', async () => {
    const state = createRadarState({ keepMuteOnSwipe: true });
    const eMulti = { uid: 20, world: 'W', comment: 'Multi', content: 'A' };
    const eSession = { uid: 21, world: 'W', comment: 'Session', content: 'B' };
    const eBoost = { uid: 22, world: 'W', comment: 'Boosted', content: 'C', disable: true };

    const forceBatches = [];
    const interceptor = createInterceptor(state, {
        fetchAllEntries: async () => [eMulti, eSession, eBoost],
        emitForceActivate: async (batch) => forceBatches.push(batch),
    });

    state.muteEntry(eMulti, { mode: MUTE_MODE.TURNS, turns: 3 });
    state.muteEntry(eSession, { mode: MUTE_MODE.SESSION });
    state.boostEntry(eBoost);

    await interceptor.handleGenerateInterceptor([{ is_user: true }], 4096, () => {}, 'normal');
    assert.equal(forceBatches.length, 1);
    assert.equal(forceBatches[0][0].uid, 22);

    await interceptor.handleGenerateInterceptor([{ is_user: true }, { is_user: true }], 4096, () => {}, 'normal');
    assert.equal(forceBatches.length, 1);
    assert.equal(state.getMutes().get(getEntryKey(eMulti))?.remainingTurns, 2);

    await interceptor.handleGenerateInterceptor([{ is_user: true }, { is_user: true }, { is_user: true }], 4096, () => {}, 'normal');
    assert.equal(state.getMutes().get(getEntryKey(eMulti))?.remainingTurns, 1);

    await interceptor.handleGenerateInterceptor([{ is_user: true }, { is_user: true }, { is_user: true }, { is_user: true }], 4096, () => {}, 'normal');
    assert.equal(state.getMutes().has(getEntryKey(eMulti)), false);
    assert.equal(state.getMutes().has(getEntryKey(eSession)), true);

    state.handleChatChanged('new_chat_42');
    assert.equal(state.getMutes().size, 0);
});

test('findMatchesAtCaret only returns entries whose trigger word is under the caret or selection', () => {
    const entries = [
        { uid: 1, world: 'W', comment: 'Shadow Guild', key: ['shadow'], content: 'Shadow lore.' },
        { uid: 2, world: 'W', comment: 'Royal Crown', key: ['crown'], content: 'Crown lore.' },
    ];
    const draft = 'A shadow near the golden crown.';
    //             0123456789012345678901234567890
    // "shadow" is [2, 8], "crown" is [25, 30]
    const scan = scanDraftAgainstLorebooks({
        entries,
        chatMessages: [],
        draftText: draft,
        scanConfig: { scanDepth: 2 },
    });

    // Caret inside "shadow" (index 5)
    assert.deepEqual(findMatchesAtCaret(scan, 5).map((m) => m.uid), [1]);
    // Caret right at the end of "shadow" (index 8)
    assert.deepEqual(findMatchesAtCaret(scan, 8).map((m) => m.uid), [1]);
    // Caret on neutral word "golden" (index 20) -> no match
    assert.deepEqual(findMatchesAtCaret(scan, 20), []);
    // Caret inside "crown" (index 27)
    assert.deepEqual(findMatchesAtCaret(scan, 27).map((m) => m.uid), [2]);
});

test('boosting a disabled Lorebook entry temporarily clears disable during WORLDINFO_ENTRIES_LOADED', async () => {
    const state = createRadarState({ keepMuteOnSwipe: true });
    const disabledEntry = { uid: 99, world: 'Secrets', comment: 'Hidden Boss', content: 'Boss awakens.', disable: true };

    const forceBatches = [];
    const interceptor = createInterceptor(state, {
        fetchAllEntries: async () => [disabledEntry],
        emitForceActivate: async (batch) => forceBatches.push(batch),
    });

    state.boostEntry(disabledEntry);
    await interceptor.handleGenerateInterceptor([{ is_user: true, mes: 'Hello' }], 4096, () => {}, 'normal');

    const loaded = { globalLore: [{ ...disabledEntry }], characterLore: [], chatLore: [], personaLore: [] };
    interceptor.handleWorldInfoEntriesLoaded(loaded);

    assert.equal(loaded.globalLore[0].disable, false, 'Cloned entry must be temporarily enabled so ST does not skip externalActivations');
    assert.equal(disabledEntry.disable, true, 'Original Lorebook entry must remain untouched');
    assert.equal(forceBatches.length, 1);
    assert.equal(forceBatches[0][0].uid, 99);
});

test('cachedBaseline produces identical results to full baseline scan and reduceAnimations defaults to false', () => {
    assert.equal(DEFAULT_SETTINGS.reduceAnimations, false);
    const entries = [
        { uid: 1, world: 'W', comment: 'HistoryEntry', key: ['tavern'], content: 'Old tavern.' },
        { uid: 2, world: 'W', comment: 'DraftEntry', key: ['shadow'], content: 'Dark shadow.' },
    ];
    const chatMessages = [{ name: 'User', mes: 'Inside the tavern.', is_user: true }];
    const full = scanDraftAgainstLorebooks({ entries, chatMessages, draftText: 'A shadow moves.', scanConfig: { scanDepth: 2 } });
    const cached = scanDraftAgainstLorebooks({
        entries,
        chatMessages,
        draftText: 'A shadow moves.',
        scanConfig: { scanDepth: 2 },
        cachedBaseline: full.baselineActivated,
    });
    assert.deepEqual(
        cached.matches.map((m) => [m.uid, m.source]),
        full.matches.map((m) => [m.uid, m.source]),
    );
});

test('Mute Chat (session mute) persists solely in extension settings across reloads', () => {
    const extSettings = {};
    const state1 = createRadarState({});
    state1.bindExtensionSettings(extSettings);

    const entryA = { uid: 101, world: 'Morvalis', comment: 'Grimbarrow' };
    const entryB = { uid: 102, world: 'Morvalis', comment: 'Shadow' };

    state1.handleChatChanged('char:alice.png:chat_1');
    state1.muteEntry(entryA, { mode: MUTE_MODE.SESSION });
    state1.muteEntry(entryB, { mode: MUTE_MODE.TURNS, turns: 1 });

    // Only the session mute should be saved in extension_settings.keyword_radar.chatMutes
    const stored = extSettings.keyword_radar.chatMutes['char:alice.png:chat_1'];
    assert.equal(stored.length, 1);
    assert.equal(stored[0].key, 'Morvalis.101');

    // Simulate closing and reopening SillyTavern with the same extension settings
    const state2 = createRadarState({});
    state2.bindExtensionSettings(extSettings);
    state2.handleChatChanged('char:alice.png:chat_1');
    assert.equal(state2.getMutes().has('Morvalis.101'), true);
    assert.equal(state2.getMutes().get('Morvalis.101')?.mode, MUTE_MODE.SESSION);
    assert.equal(state2.getMutes().has('Morvalis.102'), false);

    // Unmuting removes it cleanly from extension settings
    state2.unmuteEntry('Morvalis.101');
    assert.equal(extSettings.keyword_radar.chatMutes['char:alice.png:chat_1'], undefined);
});

test('clearAllChatMutesGlobally wipes chatMutes across all chats instantly', () => {
    const extSettings = {};
    const state = createRadarState({});
    state.bindExtensionSettings(extSettings);

    state.handleChatChanged('char:alice.png:chat_1');
    state.muteEntry({ uid: 1, world: 'W', comment: 'Mute 1' }, { mode: MUTE_MODE.SESSION });

    state.handleChatChanged('char:bob.png:chat_2');
    state.muteEntry({ uid: 2, world: 'W', comment: 'Mute 2' }, { mode: MUTE_MODE.SESSION });

    assert.deepEqual(state.getGlobalChatMuteStats(), { chatCount: 2, entryCount: 2 });

    state.clearAllChatMutesGlobally();
    assert.deepEqual(state.getGlobalChatMuteStats(), { chatCount: 0, entryCount: 0 });
    assert.equal(state.getMutes().size, 0);

    // Switching back to chat_1 confirms it is also unmuted
    state.handleChatChanged('char:alice.png:chat_1');
    assert.equal(state.getMutes().size, 0);
});

// ---------------------------------------------------------------------------
// 5. v1.4 SillyTavern 1.19+ Compatibility & Bug-Fix Tests
// ---------------------------------------------------------------------------

import { findMatchingEntry, registerRadarSlashCommands } from '../src/slashCommands.js';
import { parseRegexFromString } from '../src/utils.js';

test('parseRegexFromString rejects unescaped inner slashes just like SillyTavern world-info.js', () => {
    assert.equal(parseRegexFromString('/path/to/file/i'), null);
    assert.equal(parseRegexFromString('/foo/bar/'), null);
    const validEscaped = parseRegexFromString('/foo\\/bar/i');
    assert.ok(validEscaped instanceof RegExp);
    assert.equal(validEscaped.test('FOO/BAR'), true);
});

test('findKeywordSpans highlights all matches even when regex has sticky (y) flag', () => {
    const spans = findKeywordSpans('alpha shadow beta shadow', '/shadow/iy', {}, {});
    assert.equal(spans.length, 2);
    assert.equal(spans[0].start, 6);
    assert.equal(spans[1].start, 18);
});

test('scanner respects entry.triggers and CSV multi-group inclusion conflicts', () => {
    const entries = [
        { uid: 1, world: 'W', comment: 'Impersonate Only', key: ['storm'], triggers: ['impersonate'], content: 'Only on impersonate.' },
        { uid: 2, world: 'W', comment: 'Normal Allowed', key: ['storm'], triggers: ['normal', 'swipe'], group: 'weather, mood', content: 'Stormy.' },
        { uid: 3, world: 'W', comment: 'Mood Rival', key: ['storm'], group: 'mood', content: 'Tense.' },
    ];

    const res = scanDraftAgainstLorebooks({
        entries,
        chatMessages: [],
        draftText: 'A storm approaches.',
        scanConfig: { scanDepth: 2 },
    });

    assert.equal(res.matches.find((m) => m.uid === 1), undefined, 'Impersonate-only entry must be skipped for normal draft scan');
    const normalEntry = res.matches.find((m) => m.uid === 2);
    assert.ok(normalEntry);
    assert.deepEqual(normalEntry.groupCompetitors, ['Mood Rival']);
});

test('scanner does not falsely exclude tag-filtered entries when characterTags is null (e.g. group chat without tagMap entry)', () => {
    const entries = [
        { uid: 1, world: 'W', comment: 'Tagged Lore', key: ['guild'], characterFilter: { tags: ['tag_1'], isExclude: false }, content: 'Guild.' },
    ];
    const noTagMap = scanDraftAgainstLorebooks({
        entries,
        chatMessages: [],
        draftText: 'The guild awaits.',
        characterTags: null,
        scanConfig: { scanDepth: 2 },
    });
    assert.equal(noTagMap.matches.length, 1);

    const withOtherTags = scanDraftAgainstLorebooks({
        entries,
        chatMessages: [],
        draftText: 'The guild awaits.',
        characterTags: ['tag_other'],
        scanConfig: { scanDepth: 2 },
    });
    assert.equal(withOtherTags.matches.length, 0);
});

test('continue generation preserves 1-turn mute when keepMuteOnSwipe is true and migrateChatKey preserves chat mutes on rename', () => {
    const extSettings = {};
    const state = createRadarState({ keepMuteOnSwipe: true });
    state.bindExtensionSettings(extSettings);

    state.handleChatChanged('char:alice.png:old_chat');
    const e1 = { uid: 1, world: 'W', comment: 'TempMute' };
    const e2 = { uid: 2, world: 'W', comment: 'ChatMute' };
    state.muteEntry(e1, { mode: MUTE_MODE.TURNS, turns: 1 });
    state.muteEntry(e2, { mode: MUTE_MODE.SESSION });

    const turn1Chat = [{ is_user: true, mes: 'Hi' }];
    state.onGenerationStart({ type: 'normal', chat: turn1Chat });
    const afterContinue = state.onGenerationStart({ type: 'continue', chat: [...turn1Chat, { is_user: false, mes: 'Part 1' }] });
    assert.equal(afterContinue.mutedKeys.has('W.1'), true);

    state.migrateChatKey('char:alice.png:old_chat', 'char:alice.png:renamed_chat');
    assert.equal(extSettings.keyword_radar.chatMutes['char:alice.png:old_chat'], undefined);
    assert.equal(extSettings.keyword_radar.chatMutes['char:alice.png:renamed_chat']?.length, 1);
});

test('slashCommands disambiguates world.uid keys and registers /kr-unmute cleanly', async () => {
    const entries = [
        { uid: 0, world: 'Alpha', comment: 'Intro' },
        { uid: 0, world: 'Beta', comment: 'Intro' },
    ];
    assert.equal(findMatchingEntry(entries, 'Beta.0')?.world, 'Beta');

    const registered = new Map();
    const state = createRadarState({});
    const ok = registerRadarSlashCommands({
        ctx: {
            SlashCommandParser: { addCommandObject: (cmd) => registered.set(cmd.name, cmd) },
            SlashCommand: { fromProps: (p) => p },
            SlashCommandArgument: { fromProps: (p) => p },
            SlashCommandNamedArgument: { fromProps: (p) => p },
            SlashCommandEnumValue: class { constructor(v, d) { this.value = v; this.description = d; } },
            ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean' },
        },
        state,
        fetchActiveEntries: async () => entries,
        getCachedEntries: () => entries,
        onStateChanged: () => {},
    });

    assert.equal(ok, true);
    assert.deepEqual([...registered.keys()].sort(), ['kr-boost', 'kr-clear', 'kr-mute', 'kr-unmute']);

    await registered.get('kr-mute').callback({ turns: '2' }, 'Beta.0');
    assert.equal(state.getMutes().has('Beta.0'), true);

    await registered.get('kr-unmute').callback({}, 'Beta.0');
    assert.equal(state.getMutes().has('Beta.0'), false);
});
