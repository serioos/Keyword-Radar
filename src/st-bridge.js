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
 * Loads and caches SillyTavern core ES modules (`script.js`, `world-info.js`, `extensions.js`, `tokenizers.js`, `utils.js`).
 */
export async function loadCoreModules() {
    if (cachedModules) return cachedModules;

    const [scriptMod, worldInfoMod, extensionsMod, tokenizersMod, tagsMod, utilsMod, slashParserMod, slashCmdMod, slashArgMod] = await Promise.all([
        tryImportModule(['../../../../script.js', '../../../script.js', '/script.js']),
        tryImportModule(['../../../world-info.js', '../../world-info.js', '/scripts/world-info.js']),
        tryImportModule(['../../../extensions.js', '../../extensions.js', '/scripts/extensions.js']),
        tryImportModule(['../../../tokenizers.js', '../../tokenizers.js', '/scripts/tokenizers.js']),
        tryImportModule(['../../../tags.js', '../../tags.js', '/scripts/tags.js']),
        tryImportModule(['../../../utils.js', '../../utils.js', '/scripts/utils.js']),
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
        tags: tagsMod || {},
        utils: utilsMod || {},
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
 * Resolves the active character filename using SillyTavern's current utils.js export.
 * Older builds may expose the helper elsewhere, so avatar-based normalization is
 * retained as a non-throwing fallback.
 * @param {string|number|null|undefined} characterId
 * @param {any} character
 * @param {any} modules
 * @returns {string}
 */
export function resolveCharacterFilename(characterId, character, modules = {}) {
    const getFilename = modules?.utils?.getCharaFilename || modules?.script?.getCharaFilename;
    if (typeof getFilename === 'function') {
        try {
            const filename = getFilename(characterId);
            if (typeof filename === 'string' && filename) return filename;
        } catch {
            // Fall back to the character object when the core utility is unavailable.
        }
    }
    return String(character?.avatar || '').split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
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
export function normalizeWorldInfoGlobalSettings(live = {}, domReaders = {}) {
    const readDomNumber = typeof domReaders.readNumber === 'function'
        ? domReaders.readNumber
        : (_selector, fallback) => fallback;
    const readDomCheckbox = typeof domReaders.readCheckbox === 'function'
        ? domReaders.readCheckbox
        : (_selector, fallback) => fallback;

    const pickNumber = (key, selector, fallback) => {
        const value = live[key];
        if (value !== undefined && value !== null && value !== '') {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return parsed;
        }
        return readDomNumber(selector, fallback);
    };

    const pickBoolean = (key, selector, fallback) => {
        if (typeof live[key] === 'boolean') return live[key];
        if (live[key] !== undefined && live[key] !== null) return Boolean(live[key]);
        return readDomCheckbox(selector, fallback);
    };

    return {
        scanDepth: Math.max(0, pickNumber('world_info_depth', '#world_info_depth', 2)),
        recursive: pickBoolean('world_info_recursive', '#world_info_recursive', false),
        maxRecursionSteps: Math.max(0, pickNumber('world_info_max_recursion_steps', '#world_info_max_recursion_steps', 0)),
        caseSensitive: pickBoolean('world_info_case_sensitive', '#world_info_case_sensitive', false),
        matchWholeWords: pickBoolean('world_info_match_whole_words', '#world_info_match_whole_words', false),
        includeNames: pickBoolean('world_info_include_names', '#world_info_include_names', true),
        budget: Math.max(0, pickNumber('world_info_budget', '#world_info_budget', 25)),
        budgetCap: Math.max(0, pickNumber('world_info_budget_cap', '#world_info_budget_cap', 0)),
        minActivations: Math.max(0, pickNumber('world_info_min_activations', '#world_info_min_activations', 0)),
        minActivationsDepthMax: Math.max(0, pickNumber('world_info_min_activations_depth_max', '#world_info_min_activations_depth_max', 0)),
        useGroupScoring: pickBoolean('world_info_use_group_scoring', '#world_info_use_group_scoring', false),
        characterStrategy: pickNumber('world_info_character_strategy', '#world_info_character_strategy', 1),
    };
}

/**
 * Reads current World Info global settings from SillyTavern's authoritative live getter,
 * falling back to the visible controls on older clients.
 */
export function getWorldInfoGlobalSettings() {
    let live = {};
    try {
        live = cachedModules?.worldInfo?.getWorldInfoSettings?.() || {};
    } catch (err) {
        console.warn('[Keyword Radar] Could not read live World Info settings:', err);
    }

    const readNumber = (selector, fallback) => {
        if (typeof document === 'undefined') return fallback;
        const el = document.querySelector(selector);
        if (!el || el.value === '' || el.value === undefined) return fallback;
        const parsed = Number(el.value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };

    const readCheckbox = (selector, fallback) => {
        if (typeof document === 'undefined') return fallback;
        const el = document.querySelector(selector);
        return el ? Boolean(el.checked) : fallback;
    };

    return normalizeWorldInfoGlobalSettings(live, { readNumber, readCheckbox });
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

    // Match the current core World Info loader: the active character's book
    // plus its auxiliary books, followed by chat/persona/global books. The
    // core does not sweep every group member's lorebook into this scan.
    const characters = ctx.characters || cachedModules?.script?.characters || [];
    const chid = ctx.characterId ?? cachedModules?.script?.this_chid;
    const charLoreArray = Array.isArray(wiSettings.charLore)
        ? wiSettings.charLore
        : (Array.isArray(wiSettings.char_lore) ? wiSettings.char_lore : []);
    const chatMeta = ctx.chatMetadata || cachedModules?.script?.chat_metadata || {};
    const chatWorld = chatMeta['world_info'];
    const powerUser = ctx.powerUserSettings || cachedModules?.script?.power_user || {};
    const personaWorld = powerUser?.persona_description_lorebook;
    const selectedGlobal = Array.isArray(cachedModules?.worldInfo?.selected_world_info)
        ? cachedModules.worldInfo.selected_world_info
        : [];

    const addCharacterWorlds = (charObj) => {
        if (!charObj) return;
        const primaryWorld = charObj?.data?.extensions?.world || charObj?.world;
        if (primaryWorld && !selectedGlobal.includes(primaryWorld) && primaryWorld !== chatWorld && primaryWorld !== personaWorld) {
            addBook(primaryWorld, 'character', `Character (${charObj.name || 'Primary'})`);
        }

        const avatarFile = resolveCharacterFilename(chid, charObj, cachedModules);
        const auxEntry = charLoreArray.find((item) => item?.name === avatarFile);
        if (auxEntry && Array.isArray(auxEntry.extraBooks)) {
            for (const extra of auxEntry.extraBooks) {
                if (extra && !selectedGlobal.includes(extra) && extra !== chatWorld && extra !== personaWorld) {
                    addBook(extra, 'character', `Character Aux (${charObj.name || 'Aux'})`);
                }
            }
        }
    };

    if (chid !== undefined && chid !== null && characters[chid]) {
        addCharacterWorlds(characters[chid]);
    }

    // 2. Chat Lorebook (already-loaded global books take precedence in core)
    if (chatWorld && typeof chatWorld === 'string' && !selectedGlobal.includes(chatWorld)) {
        addBook(chatWorld, 'chat', 'Current Chat Lorebook');
    }

    // 3. Persona Lorebook (core uses the active power-user setting)
    if (personaWorld && personaWorld !== chatWorld && !selectedGlobal.includes(personaWorld)) {
        addBook(personaWorld, 'persona', 'Persona Lorebook');
    }

    // 4. Global Lorebooks
    for (const bookName of selectedGlobal) {
        addBook(bookName, 'global', 'Global World Info');
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
            normalized.hash = computeWorldInfoEntryHash(rawEntry, bookMeta.name);
            allEntries.push(normalized);
        }
    }

    // Build Scan Context (Chat messages, character fields, timed effects)
    const activeChar = (chid !== undefined && chid !== null && characters[chid]) ? characters[chid] : null;
    const charAvatarClean = activeChar?.avatar ? String(activeChar.avatar).split(/[\\/]/).pop().replace(/\.[^/.]+$/, '') : '';
    const characterFilename = resolveCharacterFilename(chid, activeChar, cachedModules) || charAvatarClean;
    const tagMap = ctx.tagMap || cachedModules?.tags?.tag_map || cachedModules?.script?.tag_map || {};
    let tagKey;
    const tagResolver = cachedModules?.tags?.getTagKeyForEntity;
    if (typeof tagResolver === 'function') {
        try {
            tagKey = tagResolver(chid);
        } catch {
            tagKey = undefined;
        }
    } else {
        // Older clients may key their tag map by the character avatar.
        tagKey = activeChar?.avatar;
    }
    const hasCharacterTagMap = Boolean(tagKey && Array.isArray(tagMap[tagKey]));
    const characterTags = hasCharacterTagMap
        ? tagMap[tagKey].map(String)
        : undefined;

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

    const extensionPromptRegistry = cachedModules?.script?.extension_prompts || ctx.extensionPrompts || {};
    const promptResolver = cachedModules?.script?.getExtensionPromptByName;
    let injectionPrompts = '';
    if (extensionPromptRegistry && typeof promptResolver === 'function') {
        const scanPromptNames = Object.entries(extensionPromptRegistry)
            .filter(([, promptInfo]) => Boolean(promptInfo?.scan))
            .map(([promptName]) => promptName);
        if (scanPromptNames.length > 0) {
            const promptValues = await Promise.all(scanPromptNames.map(async (promptName) => {
                try {
                    return await promptResolver(promptName);
                } catch {
                    return '';
                }
            }));
            injectionPrompts = promptValues
                .filter((value) => typeof value === 'string' && value.trim().length > 0)
                .map((value) => value.trim())
                .join('\n');
        }
    }

    const extraScanFields = {
        injectionPrompts,
        personaDescription: substituteMacros(powerUser?.persona_description || ''),
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
            characterFilename,
            characterFullAvatar: activeChar?.avatar || '',
            characterTags,
            characterTagsAvailable: hasCharacterTagMap,
            generationTrigger: String(ctx.generationType || ctx.generation_type || 'normal'),
            chatMessages,
            totalChatLength: rawChat.length,
            timedEffects,
            extraScanFields,
        },
    };
}

/**
 * Parses the two currently supported SillyTavern World Info content decorators.
 * Mirrors the core rule that decorator lines are only read from the beginning
 * of the content block.
 * @param {string} content
 * @returns {{ decorators: string[], content: string }}
 */
export function parseWorldInfoDecorators(content) {
    const value = String(content ?? '');
    if (!value.startsWith('@@')) return { decorators: [], content: value };

    const lines = value.split('\n');
    const decorators = [];
    let fallbacked = false;
    let contentStart = 0;
    let foundContentLine = false;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.startsWith('@@')) {
            contentStart = index;
            foundContentLine = true;
            break;
        }
        if (line.startsWith('@@@') && !fallbacked) {
            continue;
        }
        const candidate = line.startsWith('@@@') ? line.slice(1) : line;
        if (candidate.startsWith('@@activate')) {
            decorators.push('@@activate');
            fallbacked = false;
        } else if (candidate.startsWith('@@dont_activate')) {
            decorators.push('@@dont_activate');
            fallbacked = false;
        } else {
            fallbacked = true;
        }
    }

    return {
        decorators,
        // Core keeps the original content intact when every line looks like a
        // decorator (for example, a body containing only an unknown @@ token).
        content: foundContentLine ? lines.slice(contentStart).join('\n') : value,
    };
}

/**
 * Fallback implementation of SillyTavern's current cyrb53 `getStringHash`.
 * Used only if the core utility module cannot be imported.
 * @param {string} str
 * @param {number} [seed=0]
 * @returns {number}
 */
function getCoreStringHashFallback(str, seed = 0) {
    if (typeof str !== 'string') return 0;
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Computes the same entry hash SillyTavern's `getSortedEntries()` uses for sticky/cooldown state.
 * It intentionally mirrors core property order: `{ uid, world, ...rest, decorators, content }`.
 * @param {Record<string, any>} rawEntry
 * @param {string} worldName
 * @returns {number}
 */
export function computeWorldInfoEntryHash(rawEntry, worldName) {
    const { uid, ...rest } = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
    const coreEntry = { uid, world: worldName, ...rest };
    const parsedContent = parseWorldInfoDecorators(String(coreEntry.content ?? ''));
    const preparedEntry = {
        ...coreEntry,
        decorators: parsedContent.decorators,
        content: parsedContent.content,
    };
    const serialized = JSON.stringify(preparedEntry);
    const coreHash = cachedModules?.utils?.getStringHash;
    return typeof coreHash === 'function' ? coreHash(serialized) : getCoreStringHashFallback(serialized);
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
    const parsedContent = parseWorldInfoDecorators(String(raw.content ?? ''));

    return {
        uid,
        entryKey: makeEntryKey(worldName, uid),
        world: worldName,
        scope,
        key,
        keysecondary,
        comment: comment || key[0] || `Entry #${uid}`,
        rawComment: comment,
        content: parsedContent.content,
        decorators: parsedContent.decorators,
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
        useGroupScoring: raw.useGroupScoring !== undefined && raw.useGroupScoring !== null
            ? Boolean(raw.useGroupScoring)
            : (ext.use_group_scoring !== undefined && ext.use_group_scoring !== null
                ? Boolean(ext.use_group_scoring)
                : null),
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
export function extractTimedEffects(chatMeta, chatLength, allEntries, upcomingMessages = 1) {
    const sticky = new Set();
    const cooldown = new Set();
    const stickyTurnsLeft = new Map();

    const timedRoot = chatMeta?.timedWorldInfo;
    if (!timedRoot || typeof timedRoot !== 'object') {
        return { sticky, cooldown, stickyTurnsLeft };
    }

    // ST stores two top-level buckets: timedWorldInfo.sticky and
    // timedWorldInfo.cooldown. Each is keyed by `${world}.${uid}`.
    const entriesByTimedKey = new Map();
    for (const entry of allEntries || []) {
        if (!entry || entry.world === undefined || entry.uid === undefined) continue;
        entriesByTimedKey.set(`${String(entry.world)}.${String(entry.uid)}`, entry);
    }

    const scanChatLength = Math.max(0, Number(chatLength) || 0) + Math.max(0, Number(upcomingMessages) || 0);

    for (const effectType of ['sticky', 'cooldown']) {
        const bucket = timedRoot[effectType];
        if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;

        for (const [timedKey, effect] of Object.entries(bucket)) {
            if (!effect || typeof effect !== 'object') continue;

            const entry = entriesByTimedKey.get(timedKey);
            if (!entry) continue;
            const currentHash = entry.hash ?? entry.raw?.hash;
            if (currentHash !== undefined && currentHash !== null && effect.hash !== undefined
                && String(currentHash) !== String(effect.hash)) continue;

            const start = Number(effect.start);
            const end = Number(effect.end);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            if (scanChatLength <= start && !Boolean(effect.protected)) continue;
            if (scanChatLength >= end) continue;

            // ST discards old timed effects when an entry is no longer configured
            // with that effect. Avoid showing stale timers in the radar.
            if (!(Number(entry[effectType]) > 0)) continue;

            if (effectType === 'sticky') {
                sticky.add(entry.entryKey);
                stickyTurnsLeft.set(entry.entryKey, Math.max(0, end - scanChatLength));
            } else {
                cooldown.add(entry.entryKey);
            }
        }
    }

    return { sticky, cooldown, stickyTurnsLeft };
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