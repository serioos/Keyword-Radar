/**
 * Keyword Radar — STscript Slash Commands Registration
 *
 * Registers `/kr-mute`, `/kr-unmute`, `/kr-boost`, and `/kr-clear` via SillyTavern's
 * SlashCommandParser, with live `SlashCommandEnumValue` autocomplete when supported (ST 1.17+).
 */

import { LOG_PREFIX, MUTE_MODE } from './constants.js';
import { getEntryKey, getEntryTitle } from './utils.js';

/**
 * Find the best matching entry by `world.uid` key, UID, or case-insensitive title.
 */
export function findMatchingEntry(entries, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q || !Array.isArray(entries)) return null;

    // 1. Exact world.uid key match (disambiguates duplicate UIDs across lorebooks)
    const byKey = entries.find((e) => getEntryKey(e).toLowerCase() === q);
    if (byKey) return byKey;

    // 2. Exact UID match
    const byUid = entries.find((e) => String(e.uid) === q);
    if (byUid) return byUid;

    // 3. Exact title match
    const byExact = entries.find((e) => getEntryTitle(e).toLowerCase() === q);
    if (byExact) return byExact;

    // 4. Substring title match
    return entries.find((e) => getEntryTitle(e).toLowerCase().includes(q)) || null;
}

function isTruthyFlag(val) {
    if (val === true || val === 1) return true;
    const s = String(val ?? '').trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
}

export function registerRadarSlashCommands({ ctx, state, fetchActiveEntries, getCachedEntries, onStateChanged }) {
    const parser = ctx?.SlashCommandParser;
    const SlashCommand = ctx?.SlashCommand;
    const SlashCommandArgument = ctx?.SlashCommandArgument;
    const SlashCommandNamedArgument = ctx?.SlashCommandNamedArgument;
    const SlashCommandEnumValue = ctx?.SlashCommandEnumValue;
    const ARGUMENT_TYPE = ctx?.ARGUMENT_TYPE;

    if (!parser || !SlashCommand || typeof parser.addCommandObject !== 'function') {
        return false;
    }

    const entryEnumProvider = SlashCommandEnumValue
        ? () => {
            const entries = typeof getCachedEntries === 'function' ? getCachedEntries() : [];
            if (!Array.isArray(entries)) return [];
            return entries.slice(0, 150).map((e) => new SlashCommandEnumValue(
                getEntryTitle(e),
                `${e.world || 'Lorebook'} #${e.uid}`,
            ));
        }
        : undefined;

    const mutedEnumProvider = SlashCommandEnumValue
        ? () => Array.from(state.getMutes().values()).map((m) => new SlashCommandEnumValue(
            m.title || String(m.uid),
            `${m.world || 'Lorebook'} #${m.uid} (${m.mode === MUTE_MODE.SESSION ? 'chat' : `${m.remainingTurns}t`})`,
        ))
        : undefined;

    try {
        parser.addCommandObject(SlashCommand.fromProps({
            name: 'kr-mute',
            helpString: 'Mute a Lorebook entry by title, UID, or world.UID via Keyword Radar (default: 1 turn).',
            namedArgumentList: SlashCommandNamedArgument && ARGUMENT_TYPE ? [
                SlashCommandNamedArgument.fromProps({
                    name: 'turns',
                    description: 'Number of turns to mute (default: 1)',
                    typeList: [ARGUMENT_TYPE.NUMBER],
                    defaultValue: '1',
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'session',
                    description: 'Mute for the remainder of this chat session (true/false)',
                    typeList: [ARGUMENT_TYPE.BOOLEAN],
                    defaultValue: 'false',
                }),
            ] : [],
            unnamedArgumentList: SlashCommandArgument && ARGUMENT_TYPE ? [
                SlashCommandArgument.fromProps({
                    description: 'Lorebook entry title, UID, or world.UID',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: true,
                    ...(entryEnumProvider ? { enumProvider: entryEnumProvider } : {}),
                }),
            ] : [],
            callback: async (namedArgs, unnamedArgs) => {
                const query = String(unnamedArgs || '').trim();
                const entries = await fetchActiveEntries(false);
                const match = findMatchingEntry(entries, query);
                if (!match) return `Keyword Radar: No active entry matching "${query}".`;

                const isSession = isTruthyFlag(namedArgs?.session);
                const turns = Math.max(1, parseInt(namedArgs?.turns || '1', 10) || 1);
                state.muteEntry(match, isSession ? { mode: MUTE_MODE.SESSION } : { mode: MUTE_MODE.TURNS, turns });
                onStateChanged?.();
                return `Keyword Radar: Muted "${getEntryTitle(match)}" (${isSession ? 'this chat' : `${turns} turn${turns === 1 ? '' : 's'}`}).`;
            },
        }));

        parser.addCommandObject(SlashCommand.fromProps({
            name: 'kr-unmute',
            helpString: 'Unmute a previously muted Lorebook entry by title, UID, or world.UID via Keyword Radar.',
            unnamedArgumentList: SlashCommandArgument && ARGUMENT_TYPE ? [
                SlashCommandArgument.fromProps({
                    description: 'Muted Lorebook entry title, UID, or world.UID',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: true,
                    ...(mutedEnumProvider ? { enumProvider: mutedEnumProvider } : {}),
                }),
            ] : [],
            callback: async (_namedArgs, unnamedArgs) => {
                const query = String(unnamedArgs || '').trim();
                const mutedList = Array.from(state.getMutes().values()).map((r) => ({
                    ...r,
                    comment: r.title,
                }));
                const match = findMatchingEntry(mutedList, query);
                if (!match) return `Keyword Radar: No muted entry matching "${query}".`;

                state.unmuteEntry(match.key);
                onStateChanged?.();
                return `Keyword Radar: Unmuted "${match.title || getEntryTitle(match)}".`;
            },
        }));

        parser.addCommandObject(SlashCommand.fromProps({
            name: 'kr-boost',
            helpString: 'Force-trigger a Lorebook entry for the next turn via Keyword Radar.',
            unnamedArgumentList: SlashCommandArgument && ARGUMENT_TYPE ? [
                SlashCommandArgument.fromProps({
                    description: 'Lorebook entry title, UID, or world.UID',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: true,
                    ...(entryEnumProvider ? { enumProvider: entryEnumProvider } : {}),
                }),
            ] : [],
            callback: async (_namedArgs, unnamedArgs) => {
                const query = String(unnamedArgs || '').trim();
                const entries = await fetchActiveEntries(false);
                const match = findMatchingEntry(entries, query);
                if (!match) return `Keyword Radar: No active entry matching "${query}".`;

                state.boostEntry(match);
                onStateChanged?.();
                return `Keyword Radar: Boosted "${getEntryTitle(match)}" for the next turn.`;
            },
        }));

        parser.addCommandObject(SlashCommand.fromProps({
            name: 'kr-clear',
            helpString: 'Clear all active Keyword Radar mutes and manual boosts in this chat.',
            callback: () => {
                state.clearAllOverrides();
                onStateChanged?.();
                return 'Keyword Radar: Cleared all active mutes and boosts.';
            },
        }));

        return true;
    } catch (err) {
        console.warn(`${LOG_PREFIX} Could not register slash commands:`, err);
        return false;
    }
}
