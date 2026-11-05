/**
 * Keyword Radar — SillyTavern Compatibility & World Info Bridge
 * https://github.com/serioos/Keyword-Radar
 *
 * Provides resilient access to SillyTavern's core context, World Info module,
 * active lorebooks (Character, Chat, Persona, Global), tokenizers, and editor navigation.
 */

import { DEFAULT_SETTINGS, EXTENSION_NAME, METADATA_KEY } from './constants.js';
import { makeEntryKey } from './utils.js';

let cachedModules = null;

/**
 * Attempts to dynamically import a SillyTavern core module from multiple relative depths.
 * Works whether the extension is installed in `extensions/third-party/Keyword-Radar/`
 * or `extensions/Keyword-Radar/`.
 *
 * @param {string[]} candidatePaths
 * @returns {Promise<any|null>}
 */
async function tryImportModule(candidatePaths) {
    for (const relPath of candidatePaths) {
        try {
            const url = new URL(relPath, import.meta.url).href;
            return await import(url);
        } catch {
            // Try next candidate depth
        }
    }
    return null;
}

/**
 * Loads and caches SillyTavern core ES modules (`script.js`, `world-info.js`, `extensions.js`, `tokenizers.js`).
 */
export async function loadCoreModules() {
    if (cachedModules) return cachedModules;

    const [scriptMod, worldInfoMod, extensionsMod, tokenizersMod, slashParserMod, slashCmdMod, slashArgMod] = await Promise.all([
        tryImportModule(['../../../../script.js', '../../../script.js', '/script.js']),
        tryImportModule(['../../../world-info.js', '../../world-info.js', '/scripts/world-info.js']),
        tryImportModule(['../../../extensions.js', '../../extensions.js', '/scripts/extensions.js']),
        tryImportModule(['../../../tokenizers.js', '../../tokenizers.js', '/scripts/tokenizers.js']),
        tryImportModule([
            '../../../slash-commands/SlashCommandParser.js',
            '../../slash-commands/SlashCommandParser.js',
            '/scripts/slash-commands/SlashCommandParser.js',
        ]),
        tryImportModule([
            '../../../slash-commands/SlashCommand.js',
            '../../slash-commands/SlashCommand.js',
            '/scripts/slash-commands/SlashCommand.js',
        ]),
        tryImportModule([
            '../../../slash-commands/SlashCommandArgument.js',
            '../../slash-commands/SlashCommandArgument.js',
            '/scripts/slash-commands/SlashCommandArgument.js',
        ]),
    ]);

    cachedModules = {
        script: scriptMod || {},
        worldInfo: worldInfoMod || {},
        extensions: extensionsMod || {},
        tokenizers: tokenizersMod || {},
        slashParser: slashParserMod || {},
        slashCmd: slashCmdMod || {},
        slashArg: slashArgMod || {},
    };

    return cachedModules;
}

/**
 * Returns SillyTavern's global runtime context.
 * @returns {any}
 */
export function getSTContext() {
    if (typeof window !== 'undefined' && window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
        return window.SillyTavern.getContext();
    }
    if (cachedModules?.extensions?.getContext) {
        return cachedModules.extensions.getContext();
    }
    return {};
}

/**
 * Retrieves and initializes Keyword Radar extension settings.
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function getSettings() {
    const ctx = getSTContext();
    const extSettings = ctx.extensionSettings || cachedModules?.extensions?.extension_settings || {};
    if (!extSettings[EXTENSION_NAME]) {
        extSettings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS };
    } else {
        for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
            if (extSettings[EXTENSION_NAME][key] === undefined) {
                extSettings[EXTENSION_NAME][key] = val;
            }
        }
    }
    return extSettings[EXTENSION_NAME];
}

/**
 * Saves extension settings via SillyTavern's debounced persistence.
 */
export function saveSettings() {
    const ctx = getSTContext();
    if (typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
        return;
    }
    if (typeof cachedModules?.script?.saveSettingsDebounced === 'function') {
        cachedModules.script.saveSettingsDebounced();
    }
}

/**
 * Gets or initializes Keyword Radar's per-chat metadata object.
 * @returns {{ sessionMutes: string[], sessionBoosts: string[] }}
 */
export function getChatRadarMetadata() {
    const ctx = getSTContext();
    const chatMeta = ctx.chatMetadata || cachedModules?.script?.chat_metadata;
    if (!chatMeta || typeof chatMeta !== 'object') {
        return { sessionMutes: [], sessionBoosts: [] };
    }
    if (!chatMeta[METADATA_KEY] || typeof chatMeta[METADATA_KEY] !== 'object') {
        chatMeta[METADATA_KEY] = { sessionMutes: [], sessionBoosts: [] };
    }
    if (!Array.isArray(chatMeta[METADATA_KEY].sessionMutes)) {
        chatMeta[METADATA_KEY].sessionMutes = [];
    }
    if (!Array.isArray(chatMeta[METADATA_KEY].sessionBoosts)) {
        chatMeta[METADATA_KEY].sessionBoosts = [];
    }
    return chatMeta[METADATA_KEY];
}

/**
 * Saves chat metadata via SillyTavern's debounced persistence.
 */
export function saveChatRadarMetadata() {
    const ctx = getSTContext();
    if (typeof ctx.saveMetadataDebounced === 'function') {
        ctx.saveMetadataDebounced();
        return;
    }
    if (typeof cachedModules?.extensions?.saveMetadataDebounced === 'function') {
        cachedModules.extensions.saveMetadataDebounced();
    }
}

/**
 * Substitutes SillyTavern macros (e.g. `{{user}}`, `{{char}}`) in a string.
 * @param {string} text
 * @returns {string}
 */
export function substituteMacros(text) {
    if (!text || typeof text !== 'string') return '';
    const ctx = getSTContext();
    if (typeof ctx.substituteParams === 'function') {
        try {
            return ctx.substituteParams(text);
        } catch {
            return text;
        }
    }
    if (typeof cachedModules?.script?.substituteParams === 'function') {
        try {
            return cachedModules.script.substituteParams(text);
        } catch {
            return text;
        }
    }
    return text
        .replace(/\{\{user\}\}/gi, ctx.name1 || 'User')
        .replace(/\{\{char\}\}/gi, ctx.name2 || 'Character');
}

/**
 * Asynchronous token counter using SillyTavern's active tokenizer.
 * @param {string} text
 * @returns {Promise<number>}
 */
export async function countTokensAsync(text) {
    if (!text || typeof text !== 'string') return 0;
    const substituted = substituteMacros(text);
    const ctx = getSTContext();
    if (typeof ctx.getTokenCountAsync === 'function') {
        return await ctx.getTokenCountAsync(substituted);
    }
    if (typeof cachedModules?.tokenizers?.getTokenCountAsync === 'function') {
        return await cachedModules.tokenizers.getTokenCountAsync(substituted);
    }
    if (typeof ctx.getTokenCount === 'function') {
        return ctx.getTokenCount(substituted);
    }
    return Math.ceil(substituted.length / 3.6);
}

/**
 * Reads current World Info global settings from `world-info.js` and DOM controls.
 */
export function getWorldInfoGlobalSettings() {
    const wi = cachedModules?.worldInfo?.world_info || {};
    const includeNamesExport = cachedModules?.worldInfo?.world_info_include_names;

    const readDomNumber = (selector, fallback) => {
        if (typeof document === 'undefined') return fallback;
        const el = document.querySelector(selector);
        if (!el || el.value === '' || el.value === undefined) return fallback;
        const parsed = Number(el.value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };

    const readDomCheckbox = (selector, fallback) => {
        if (typeof document === 'undefined') return fallback;
        const el = document.querySelector(selector);
        if (!el) return fallback;
        return Boolean(el.checked);
    };

    const scanDepth = wi.world_info_depth ?? readDomNumber('#world_info_depth', 2);
    const recursive = wi.world_info_recursive ?? readDomCheckbox('#world_info_recursive', true);
    const maxRecursionSteps = wi.world_info_max_recursion_steps ?? readDomNumber('#world_info_max_recursion_steps', 0);
    const caseSensitive = wi.world_info_case_sensitive ?? readDomCheckbox('#world_info_case_sensitive', false);
    const matchWholeWords = wi.world_info_match_whole_words ?? readDomCheckbox('#world_info_match_whole_words', true);
    const includeNames = includeNamesExport ?? wi.world_info_include_names ?? readDomCheckbox('#world_info_include_names', true);
    const budget = wi.world_info_budget ?? readDomNumber('#world_info_budget', 25);
    const budgetCap = wi.world_info_budget_cap ?? readDomNumber('#world_info_budget_cap', 0);

    return {
        scanDepth: Math.max(0, Number(scanDepth) || 2),
        recursive: Boolean(recursive),
        maxRecursionSteps: Math.max(0, Number(maxRecursionSteps) || 0),
        caseSensitive: Boolean(caseSensitive),
        matchWholeWords: Boolean(matchWholeWords),
        includeNames: Boolean(includeNames),
        budget: Number(budget) || 25,
        budgetCap: Number(budgetCap) || 0,
    };
}

/**
 * Loads a single Lorebook by name via SillyTavern's `loadWorldInfo` API.
 * @param {string} bookName
 * @returns {Promise<{ entries: Record<string, any> } | null>}
 */
export async function loadLorebookByName(bookName) {
    if (!bookName || typeof bookName !== 'string') return null;
    const ctx = getSTContext();
    const loader = ctx.loadWorldInfo || cachedModules?.worldInfo?.loadWorldInfo;

    if (typeof loader === 'function') {
        try {
            const data = await loader(bookName);
            if (data && typeof data === 'object' && data.entries) {
                return data;
            }
        } catch (err) {
            console.warn(`[Keyword Radar] Failed to load world info "${bookName}":`, err);
        }
    }

    // Fallback: direct REST API call to SillyTavern backend
    try {
        const headers = typeof ctx.getRequestHeaders === 'function'
            ? ctx.getRequestHeaders()
            : (typeof cachedModules?.script?.getRequestHeaders === 'function'
                ? cachedModules.script.getRequestHeaders()
                : { 'Content-Type': 'application/json' });

        const resp = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: bookName }),
        });
        if (resp.ok) {
            const data = await resp.json();
            if (data && typeof data === 'object' && data.entries) {
                return data;
            }
        }
    } catch (err) {
        console.warn(`[Keyword Radar] Fallback fetch failed for world info "${bookName}":`, err);
    }

    return null;
}

/**
 * Saves modified fields on a specific Lorebook entry and refreshes the World Info editor if open.
 * @param {string} bookName
 * @param {string|number} uid
 * @param {Partial<{ comment: string, content: string, key: string[], keysecondary: string[], selective: boolean, selectiveLogic: number, caseSensitive: boolean|null, matchWholeWords: boolean|null, constant: boolean, disable: boolean }>} updatedFields
 * @returns {Promise<boolean>}
 */
export async function saveLorebookEntryFields(bookName, uid, updatedFields) {
    const bookData = await loadLorebookByName(bookName);
    if (!bookData || !bookData.entries) {
        throw new Error(`Could not load Lorebook "${bookName}".`);
    }

    const entryKey = Object.keys(bookData.entries).find(
        (k) => String(k) === String(uid) || String(bookData.entries[k]?.uid) === String(uid),
    );
    if (!entryKey || !bookData.entries[entryKey]) {
        throw new Error(`Entry UID "${uid}" not found in Lorebook "${bookName}".`);
    }

    const target = bookData.entries[entryKey];
    const allowedKeys = [
        'comment',
        'content',
        'key',
        'keysecondary',
        'selective',
        'selectiveLogic',
        'caseSensitive',
        'matchWholeWords',
        'constant',
        'disable',
    ];

    for (const k of allowedKeys) {
        if (updatedFields[k] !== undefined) {
            target[k] = updatedFields[k];
        }
    }

    const ctx = getSTContext();
    const saver = ctx.saveWorldInfo || cachedModules?.worldInfo?.saveWorldInfo;
    if (typeof saver === 'function') {
        await saver(bookName, bookData, true);
    } else {
        const headers = typeof ctx.getRequestHeaders === 'function'
            ? ctx.getRequestHeaders()
            : { 'Content-Type': 'application/json' };
        const resp = await fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: bookName, data: bookData }),
        });
        if (!resp.ok) {
            throw new Error(`Failed to save Lorebook "${bookName}" (HTTP ${resp.status}).`);
        }
    }

    if (typeof ctx.reloadWorldInfoEditor === 'function') {
        ctx.reloadWorldInfoEditor(bookName, true);
    } else if (typeof cachedModules?.worldInfo?.reloadEditor === 'function') {
        cachedModules.worldInfo.reloadEditor(bookName, true);
    }

    return true;
}

/**
 * Discovers all currently active Lorebooks across Character (Primary + Aux + Group),
 * Chat, Persona, and Global scopes.
 */
export async function collectActiveLorebooksAndContext() {
    await loadCoreModules();
    const ctx = getSTContext();
    const wiSettings = cachedModules?.worldInfo?.world_info || {};
    const globalSettings = getWorldInfoGlobalSettings();

    /** @type {Map<string, { name: string, scope: 'character'|'chat'|'persona'|'global', scopeDetail: string }>} */
    const activeBooksMap = new Map();

    const addBook = (name, scope, scopeDetail) => {
        const cleanName = typeof name === 'string' ? name.trim() : '';
        if (!cleanName) return;
        if (!activeBooksMap.has(cleanName)) {
            activeBooksMap.set(cleanName, { name: cleanName, scope, scopeDetail });
        }
    };

    // 1. Character Lorebooks (Single character or Group chat members)
    const characters = ctx.characters || cachedModules?.script?.characters || [];
    const chid = ctx.characterId ?? cachedModules?.script?.this_chid;
    const groupId = ctx.groupId ?? cachedModules?.worldInfo?.selected_group;
    const groups = ctx.groups || [];
    const charLoreArray = Array.isArray(wiSettings.char_lore) ? wiSettings.char_lore : [];

    const addCharacterWorlds = (charObj) => {
        if (!charObj) return;
        const primaryWorld = charObj?.data?.extensions?.world || charObj?.world;
        if (primaryWorld) {
            addBook(primaryWorld, 'character', `Character (${charObj.name || 'Primary'})`);
        }
        const avatarFile = String(charObj.avatar || '').replace(/\.png$/i, '');
        const auxEntry = charLoreArray.find(
            (item) => item?.name === avatarFile || item?.name === charObj.avatar || item?.name === charObj.name,
        );
        if (auxEntry && Array.isArray(auxEntry.extraBooks)) {
            for (const extra of auxEntry.extraBooks) {
                addBook(extra, 'character', `Character Aux (${charObj.name || 'Aux'})`);
            }
        }
    };

    if (groupId && Array.isArray(groups)) {
        const activeGroup = groups.find((g) => String(g.id) === String(groupId));
        if (activeGroup && Array.isArray(activeGroup.members)) {
            for (const memberAvatar of activeGroup.members) {
                const memberChar = characters.find((c) => c?.avatar === memberAvatar);
                addCharacterWorlds(memberChar);
            }
        }
    } else if (chid !== undefined && chid !== null && characters[chid]) {
        addCharacterWorlds(characters[chid]);
    }

    // 2. Chat Lorebook
    const chatMeta = ctx.chatMetadata || cachedModules?.script?.chat_metadata || {};
    const chatWorld = chatMeta['world_info'];
    if (chatWorld && typeof chatWorld === 'string') {
        addBook(chatWorld, 'chat', 'Current Chat Lorebook');
    }

    // 3. Persona Lorebook
    const powerUser = ctx.powerUserSettings || cachedModules?.script?.power_user || {};
    const userAvatar = ctx.userAvatar || cachedModules?.script?.user_avatar;
    const personaDescriptor = userAvatar && powerUser?.persona_descriptions?.[userAvatar];
    if (personaDescriptor?.lorebook) {
        addBook(personaDescriptor.lorebook, 'persona', 'Persona Lorebook');
    } else if (powerUser?.persona_description_lorebook) {
        addBook(powerUser.persona_description_lorebook, 'persona', 'Persona Lorebook');
    }

    // 4. Global Lorebooks
    const selectedGlobal = cachedModules?.worldInfo?.selected_world_info;
    if (Array.isArray(selectedGlobal)) {
        for (const bookName of selectedGlobal) {
            addBook(bookName, 'global', 'Global World Info');
        }
    } else if (typeof document !== 'undefined') {
        const selectEl = document.querySelector('#world_info');
        if (selectEl && selectEl.selectedOptions) {
            for (const opt of Array.from(selectEl.selectedOptions)) {
                const bookName = opt.textContent?.trim() || opt.value;
                if (bookName && !bookName.startsWith('---')) {
                    addBook(bookName, 'global', 'Global World Info');
                }
            }
        }
    }

    // Load all active books in parallel
    const books = Array.from(activeBooksMap.values());
    const loadedBooks = await Promise.all(
        books.map(async (bookMeta) => {
            const data = await loadLorebookByName(bookMeta.name);
            return { bookMeta, data };
        }),
    );

    const allEntries = [];
    for (const { bookMeta, data } of loadedBooks) {
        if (!data || !data.entries || typeof data.entries !== 'object') continue;
        for (const [rawKey, rawEntry] of Object.entries(data.entries)) {
            if (!rawEntry || typeof rawEntry !== 'object') continue;
            const normalized = normalizeWorldInfoEntry(rawEntry, rawKey, bookMeta.name, bookMeta.scope);
            allEntries.push(normalized);
        }
    }

    // Build Scan Context (Chat messages, character fields, timed effects)
    const activeChar = (chid !== undefined && chid !== null && characters[chid]) ? characters[chid] : null;
    const charAvatarClean = activeChar?.avatar ? String(activeChar.avatar).replace(/\.png$/i, '') : '';
    const tagMap = ctx.tagMap || {};
    const characterTags = (activeChar?.avatar && Array.isArray(tagMap[activeChar.avatar]))
        ? tagMap[activeChar.avatar].map((t) => t?.name || t).filter(Boolean)
        : [];

    const rawChat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const chatMessages = rawChat
        .filter((m) => m && !m.is_system && typeof m.mes === 'string')
        .map((m) => ({
            name: m.name || (m.is_user ? (ctx.name1 || 'User') : (ctx.name2 || 'Character')),
            mes: m.mes,
            is_user: Boolean(m.is_user),
            is_system: Boolean(m.is_system),
        }));

    // Extract active sticky & cooldown timed effects from chat_metadata.timedWorldInfo
    const timedEffects = extractTimedEffects(chatMeta, rawChat.length, allEntries);

    const extraScanFields = {
        personaDescription: substituteMacros(powerUser?.persona_description || personaDescriptor?.description || ''),
        characterDescription: substituteMacros(activeChar?.description || activeChar?.data?.description || ''),
        characterPersonality: substituteMacros(activeChar?.personality || activeChar?.data?.personality || ''),
        characterDepthPrompt: substituteMacros(activeChar?.data?.extensions?.depth_prompt?.prompt || ''),
        scenario: substituteMacros(activeChar?.scenario || activeChar?.data?.scenario || ''),
        creatorNotes: substituteMacros(activeChar?.data?.creator_notes || ''),
    };

    return {
        books,
        entries: allEntries,
        globalSettings,
        scanContext: {
            name1: ctx.name1 || 'User',
            name2: ctx.name2 || activeChar?.name || 'Character',
            characterAvatar: charAvatarClean,
            characterFullAvatar: activeChar?.avatar || '',
            characterTags,
            chatMessages,
            totalChatLength: rawChat.length,
            timedEffects,
            extraScanFields,
        },
    };
}

/**
 * Normalizes a World Info entry object across SillyTavern versions (handling both camelCase & snake_case).
 * @param {any} raw
 * @param {string|number} fallbackUid
 * @param {string} worldName
 * @param {'character'|'chat'|'persona'|'global'} scope
 */
export function normalizeWorldInfoEntry(raw, fallbackUid, worldName, scope = 'global') {
    const ext = raw.extensions && typeof raw.extensions === 'object' ? raw.extensions : {};
    const uid = raw.uid ?? fallbackUid ?? 0;

    const toArray = (val) => {
        if (Array.isArray(val)) {
            return val.map((k) => String(k ?? '').trim()).filter(Boolean);
        }
        if (typeof val === 'string' && val.trim()) {
            return val.split(',').map((k) => k.trim()).filter(Boolean);
        }
        return [];
    };

    const key = toArray(raw.key ?? raw.keys);
    const keysecondary = toArray(raw.keysecondary ?? raw.secondary_keys);
    const comment = String(raw.comment ?? raw.name ?? '').trim();
    const content = String(raw.content ?? '');

    return {
        uid,
        entryKey: makeEntryKey(worldName, uid),
        world: worldName,
        scope,
        key,
        keysecondary,
        comment: comment || key[0] || `Entry #${uid}`,
        rawComment: comment,
        content,
        constant: Boolean(raw.constant),
        vectorized: Boolean(raw.vectorized ?? ext.vectorized),
        selective: raw.selective !== undefined ? Boolean(raw.selective) : true,
        selectiveLogic: Number(raw.selectiveLogic ?? raw.selective_logic ?? ext.selectiveLogic ?? 0),
        order: Number(raw.order ?? raw.insertion_order ?? 100),
        position: Number(raw.position ?? ext.position ?? 0),
        depth: Number(raw.depth ?? ext.depth ?? 4),
        role: Number(raw.role ?? ext.role ?? 0),
        disable: Boolean(raw.disable ?? (raw.enabled === false)),
        excludeRecursion: Boolean(raw.excludeRecursion ?? raw.exclude_recursion ?? ext.exclude_recursion),
        preventRecursion: Boolean(raw.preventRecursion ?? raw.prevent_recursion ?? ext.prevent_recursion),
        delayUntilRecursion: Number(raw.delayUntilRecursion ?? raw.delay_until_recursion ?? ext.delay_until_recursion ?? 0),
        probability: Number(raw.probability ?? ext.probability ?? 100),
        useProbability: raw.useProbability !== undefined
            ? Boolean(raw.useProbability)
            : Boolean(ext.useProbability ?? true),
        scanDepth: (raw.scanDepth !== null && raw.scanDepth !== undefined && raw.scanDepth !== '')
            ? Number(raw.scanDepth)
            : ((ext.scan_depth !== null && ext.scan_depth !== undefined && ext.scan_depth !== '') ? Number(ext.scan_depth) : null),
        caseSensitive: (raw.caseSensitive !== null && raw.caseSensitive !== undefined)
            ? Boolean(raw.caseSensitive)
            : ((ext.case_sensitive !== null && ext.case_sensitive !== undefined) ? Boolean(ext.case_sensitive) : null),
        matchWholeWords: (raw.matchWholeWords !== null && raw.matchWholeWords !== undefined)
            ? Boolean(raw.matchWholeWords)
            : ((ext.match_whole_words !== null && ext.match_whole_words !== undefined) ? Boolean(ext.match_whole_words) : null),
        useGroupScoring: Boolean(raw.useGroupScoring ?? ext.use_group_scoring),
        automationId: String(raw.automationId ?? ext.automation_id ?? ''),
        group: String(raw.group ?? ext.group ?? ''),
        groupOverride: Boolean(raw.groupOverride ?? ext.group_override),
        groupWeight: Number(raw.groupWeight ?? ext.group_weight ?? 100),
        sticky: Number(raw.sticky ?? ext.sticky ?? 0),
        cooldown: Number(raw.cooldown ?? ext.cooldown ?? 0),
        delay: Number(raw.delay ?? ext.delay ?? 0),
        matchPersonaDescription: Boolean(raw.matchPersonaDescription ?? ext.match_persona_description),
        matchCharacterDescription: Boolean(raw.matchCharacterDescription ?? ext.match_character_description),
        matchCharacterPersonality: Boolean(raw.matchCharacterPersonality ?? ext.match_character_personality),
        matchCharacterDepthPrompt: Boolean(raw.matchCharacterDepthPrompt ?? ext.match_character_depth_prompt),
        matchScenario: Boolean(raw.matchScenario ?? ext.match_scenario),
        matchCreatorNotes: Boolean(raw.matchCreatorNotes ?? ext.match_creator_notes),
        characterFilter: normalizeCharacterFilter(raw.characterFilter ?? ext.character_filter),
        triggers: Array.isArray(raw.triggers) ? raw.triggers : (Array.isArray(ext.triggers) ? ext.triggers : []),
        raw,
    };
}

/**
 * Normalizes the optional `characterFilter` object on a Lorebook entry.
 * @param {any} cf
 * @returns {{ isExclude: boolean, names: string[], tags: string[] } | null}
 */
function normalizeCharacterFilter(cf) {
    if (!cf || typeof cf !== 'object') return null;
    const names = Array.isArray(cf.names) ? cf.names.map((n) => String(n).trim()).filter(Boolean) : [];
    const tags = Array.isArray(cf.tags) ? cf.tags.map((t) => String(t).trim()).filter(Boolean) : [];
    if (names.length === 0 && tags.length === 0) return null;
    return {
        isExclude: Boolean(cf.isExclude),
        names,
        tags,
    };
}

/**
 * Parses `chat_metadata.timedWorldInfo` to detect currently active sticky or cooldown entries.
 * Compatible with SillyTavern's `WI_TIMED_EFFECT_TYPE` structure.
 *
 * @param {any} chatMeta
 * @param {number} chatLength
 * @param {Array<any>} allEntries
 * @returns {{ sticky: Set<string>, cooldown: Set<string>, stickyTurnsLeft: Map<string, number> }}
 */
function extractTimedEffects(chatMeta, chatLength, allEntries) {
    const sticky = new Set();
    const cooldown = new Set();
    const stickyTurnsLeft = new Map();

    const timedRoot = chatMeta?.timedWorldInfo;
    if (!timedRoot || typeof timedRoot !== 'object') {
        return { sticky, cooldown, stickyTurnsLeft };
    }

    const entriesByWorld = new Map();
    for (const entry of allEntries) {
        if (!entriesByWorld.has(entry.world)) {
            entriesByWorld.set(entry.world, []);
        }
        entriesByWorld.get(entry.world).push(entry);
    }

    const inspectEffectBucket = (worldName, effectType, bucketObj) => {
        if (!bucketObj || typeof bucketObj !== 'object') return;
        const worldEntries = entriesByWorld.get(worldName) || [];

        for (const [effectKey, effectData] of Object.entries(bucketObj)) {
            if (!effectData || typeof effectData !== 'object') continue;
            const end = Number(effectData.end ?? 0);
            const ignore = Boolean(effectData.ignore);
            if (ignore || (end > 0 && chatLength >= end)) continue;

            const matchedEntry = worldEntries.find(
                (e) =>
                    String(e.uid) === String(effectKey) ||
                    String(e.uid) === String(effectData.uid) ||
                    (effectData.hash !== undefined && String(getEntryHashFallback(e)) === String(effectData.hash)),
            );

            if (matchedEntry) {
                if (effectType === 'sticky') {
                    sticky.add(matchedEntry.entryKey);
                    if (end > chatLength) {
                        stickyTurnsLeft.set(matchedEntry.entryKey, end - chatLength);
                    }
                } else if (effectType === 'cooldown') {
                    cooldown.add(matchedEntry.entryKey);
                }
            }
        }
    };

    for (const [worldName, worldEffects] of Object.entries(timedRoot)) {
        if (!worldEffects || typeof worldEffects !== 'object') continue;
        inspectEffectBucket(worldName, 'sticky', worldEffects.sticky);
        inspectEffectBucket(worldName, 'cooldown', worldEffects.cooldown);
    }

    return { sticky, cooldown, stickyTurnsLeft };
}

/**
 * Computes a string hash matching SillyTavern's `getStringHash` for timed effect correlation.
 * @param {any} entry
 * @returns {number}
 */
function getEntryHashFallback(entry) {
    const str = `${entry.world}.${entry.uid}.${entry.comment}.${entry.content}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const chr = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return Math.abs(hash);
}

/**
 * Opens the World Info panel and scrolls to / highlights a specific Lorebook entry.
 *
 * @param {string} worldName
 * @param {string|number} uid
 * @returns {Promise<boolean>}
 */
export async function openWorldInfoEntryInEditor(worldName, uid) {
    await loadCoreModules();
    const ctx = getSTContext();

    try {
        const wiDrawerIcon = document.querySelector('#WIDrawerIcon, #world_info_drawer_icon, [data-drawer="WorldInfo"]');
        const wiDrawerContent = document.querySelector('#WorldInfo');
        if (wiDrawerContent && wiDrawerContent.classList.contains('closedDrawer') && wiDrawerIcon) {
            wiDrawerIcon.click();
        }

        const editorSelect = /** @type {HTMLSelectElement|null} */ (document.querySelector('#world_editor_select'));
        if (editorSelect) {
            const option = Array.from(editorSelect.options).find(
                (opt) => opt.textContent?.trim() === worldName || opt.value === worldName,
            );
            if (option) {
                editorSelect.value = option.value;
                editorSelect.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (typeof ctx.reloadWorldInfoEditor === 'function') {
                ctx.reloadWorldInfoEditor(worldName, true);
            }
        } else if (typeof ctx.reloadWorldInfoEditor === 'function') {
            ctx.reloadWorldInfoEditor(worldName, true);
        }

        await new Promise((r) => setTimeout(r, 280));
        const entrySelector = `#world_popup_entries_list .world_entry[uid="${uid}"], .world_entry[data-uid="${uid}"], #world_popup_entries_list [uid="${uid}"]`;
        const entryEl = document.querySelector(entrySelector);
        if (entryEl) {
            entryEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            entryEl.classList.add('kr-editor-flash');
            setTimeout(() => entryEl.classList.remove('kr-editor-flash'), 2200);
            return true;
        }
    } catch (err) {
        console.warn('[Keyword Radar] Could not navigate to World Info editor entry:', err);
    }

    return false;
}