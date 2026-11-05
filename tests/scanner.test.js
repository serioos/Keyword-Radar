/**
 * Keyword Radar — Unit Tests for Scanner Engine & Multi-Stage Mute Lifecycle
 * Run with: node tests/scanner.test.js
 */

import assert from 'node:assert/strict';
import { SELECTIVE_LOGIC, TRIGGER_STATUS } from '../src/constants.js';
import {
    evaluateEntryKeysAgainstBuffer,
    matchSingleKeyInText,
    runPreSendRadarScan,
} from '../src/scanner.js';
import { RadarStateManager } from '../src/state.js';
import { makeEntryKey } from '../src/utils.js';

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

console.log('✅ All Keyword Radar scanner & multi-stage mute unit tests passed!');