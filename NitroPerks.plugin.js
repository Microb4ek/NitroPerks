/**
 * @name NitroPerks
 * @author Microb4ek
 * @authorLink https://github.com/Microb4ek
 * @version 2.4.0
 * @description Unlock all screensharing modes, use cross-server emotes & gif emotes Discord wide, and share a custom avatar, profile banner, avatar frame and nameplate with other NitroPerks users! (You CANNOT upload 100MB files though. :/)
 * @website https://github.com/Microb4ek/NitroPerks
 * @source https://raw.githubusercontent.com/Microb4ek/NitroPerks/main/NitroPerks.plugin.js
 */
/*@cc_on
@if (@_jscript)

	// Offer to self-install for clueless users that try to run this directly.
	var shell = WScript.CreateObject("WScript.Shell");
	var fs = new ActiveXObject("Scripting.FileSystemObject");
	var pathPlugins = shell.ExpandEnvironmentStrings("%APPDATA%\\BetterDiscord\\plugins");
	var pathSelf = WScript.ScriptFullName;
	// Put the user at ease by addressing them in the first person
	shell.Popup("It looks like you've mistakenly tried to run me directly. \n(Don't do that!)", 0, "I'm a plugin for BetterDiscord", 0x30);
	if (fs.GetParentFolderName(pathSelf) === fs.GetAbsolutePathName(pathPlugins)) {
		shell.Popup("I'm in the correct folder already.", 0, "I'm already installed", 0x40);
	} else if (!fs.FolderExists(pathPlugins)) {
		shell.Popup("I can't find the BetterDiscord plugins folder.\nAre you sure it's even installed?", 0, "Can't install myself", 0x10);
	} else if (shell.Popup("Should I copy myself to BetterDiscord's plugins folder for you?", 0, "Do you need some help?", 0x34) === 6) {
		fs.CopyFile(pathSelf, fs.BuildPath(pathPlugins, fs.GetFileName(pathSelf)), true);
		// Show the user where to put plugins in the future
		shell.Exec("explorer " + pathPlugins);
		shell.Popup("I'm installed!", 0, "Successfully installed", 0x40);
	}
	WScript.Quit();

@else@*/

// Rewritten for BetterDiscord 1.11+ (no ZeresPluginLibrary) and the 2026 Discord client.
//
// How it works now:
//  * Nitro checks go through a frozen "PremiumUtils" object (canUseEmojisEverywhere, canStreamQuality, ...),
//    which reads user.premiumType — or, under the "denormalized-perks-access-read" experiment, user.perks.
//    So we spoof premiumType = 2 and clear perks on the current user record (UserStore.getCurrentUser hook,
//    because Discord replaces that record on every USER_UPDATE).
//  * Emotes the account can't really use are swapped for CDN links in MessageActions._sendMessage / editMessage.
//  * The custom avatar hooks the avatar URL helpers instead of rewriting <img src> in a 100ms loop.
//  * Custom banner: the profile popout builds a DisplayProfile from UserProfileStore.getUserProfile and draws
//    displayProfile.getPreviewBanner() → getBannerURL(). DisplayProfile isn't exported, but getDisplayProfile
//    is and accepts its stores as an argument, so a dummy call gives us the prototype to patch getBannerURL.
//    Profiles without a real banner get a Proxy that reports a placeholder `banner`, so Discord draws one.
//  * Avatar frames and nameplates: the User class getters avatarDecoration / nameplate are overridden on the
//    prototype to return fake collectibles with a placeholder skuId; their asset URLs are swapped in the DOM.
//  * Shared cosmetics, no server: the links are appended to "About Me" as invisible Unicode tag characters
//    (U+E0020–E007E, one per ASCII char): "np:a<link> b<link> f<link> n<link>". Only the profile owner can edit the bio, so
//    nobody can set them for someone else. Discord loads bios lazily (profile popout, DM sidebar), so we
//    read them from USER_PROFILE_FETCH_SUCCESS and keep what we learn in a local cache.
//  * Experimental stream FPS: Discord's picker stops at 60, but the native connection's setGoLiveSource
//    passes quality.frameRate straight to the encoder (setDesktopEncodingOptions) and to the stream's
//    maxFrameRate, so we swap 60 for the chosen value there. The media server may still cap it.
//  * Voice bitrate: every connection (voice channel, DM call, Go Live stream) gets setBitRate(channel bitrate)
//    on connect and on SET_CHANNEL_BITRATE; the native one forwards it as encodingVoiceBitRate to the Opus
//    encoder (the stream's sound uses max(soundshare minimum, that value)). Same prototype trick as stream FPS:
//    we swap the argument, and re-send it on live connections so a change applies without reconnecting.

const PREMIUM_TIER_2 = 2;
const PICKER_MAX_FPS = 60;
const DEFAULT_VOICE_BITRATE = 64000; // Discord's own default (DMs, unboosted servers)

const DEFAULT_SETTINGS = {
    spoofNitro: true,
    emojiBypass: true,
    emojiSize: 48,
    clientsidePfp: false,
    pfpUrl: "",
    customBanner: false,
    bannerUrl: "",
    customDecoration: false,
    decorationUrl: "",
    customNameplate: false,
    nameplateUrl: "",
    shareAvatar: false,
    showShared: true,
    streamFps: 0, // 0 = leave Discord's value
    voiceBitrate: 0 // kbps, 0 = leave Discord's value
};

const isValidUrl = value => {
    try {
        return /^https?:$/.test(new URL(value).protocol);
    } catch {
        return false;
    }
};

// --- hidden profile code in "About Me" ---
const TAG_BASE = 0xE0000;
const TAG_RUN = /[\u{E0020}-\u{E007E}]+/gu;
const CODE_PREFIX = "np:";
const BANNER_PLACEHOLDER = "nitroperks"; // fake banner hash so Discord renders a banner at all
// Fake collectibles skuIds: Discord turns them into cdn…/media/v1/collectibles-shop/<skuId>/<format>,
// which the DOM safety net maps back to the user's link. kind: "f" = avatar frame, "n" = nameplate.
const COLLECTIBLE_PREFIX = "nitroperks-";
const fakeSkuId = (userId, kind) => `${COLLECTIBLE_PREFIX}${userId}-${kind}`;
// Every shareable cosmetic: settings switch + link, and its one-letter key in the About Me code.
const COSMETICS = {
    avatar: {key: "a", toggle: "clientsidePfp", link: "pfpUrl"},
    banner: {key: "b", toggle: "customBanner", link: "bannerUrl"},
    decoration: {key: "f", toggle: "customDecoration", link: "decorationUrl"},
    nameplate: {key: "n", toggle: "customNameplate", link: "nameplateUrl"}
};
// Short host codes keep the hidden text small (the bio limit counts it too). Order matters: specific first.
const HOSTS = [
    ["D/", "https://cdn.discordapp.com/assets/collectibles/nameplates/"], // Discord's own nameplate art
    ["P/", "https://cdn.discordapp.com/avatar-decoration-presets/"], // Discord's own avatar decorations
    ["U/", "https://ugc.decor.fieryflames.dev/"], // Decor community avatar frames
    ["i/", "https://i.imgur.com/"],
    ["d/", "https://cdn.discordapp.com/"],
    ["m/", "https://media.discordapp.net/"],
    ["t/", "https://media.tenor.com/"],
    ["T/", "https://media1.tenor.com/"],
    ["b/", "https://i.ibb.co/"],
    ["s/", "https://"],
    ["h/", "http://"]
];

const packLink = url => {
    const href = new URL(url).href; // percent-encodes anything outside ASCII, so no spaces either
    const [code, prefix] = HOSTS.find(([, p]) => href.startsWith(p));
    return code + href.slice(prefix.length);
};

const unpackLink = packed => {
    const host = HOSTS.find(([code]) => packed.startsWith(code));
    const url = host && host[1] + packed.slice(host[0].length);
    return url && isValidUrl(url) ? url : null;
};

// one-click GIF searches in the banner catalog
const GIF_SUGGESTIONS = ["dota 2", "anime", "aesthetic", "space", "nature", "neon", "rain", "cat", "gaming", "sunset", "cyberpunk", "pixel art"];

const emptyCosmetics = () => Object.fromEntries(Object.keys(COSMETICS).map(name => [name, null]));
const sameCosmetics = (a, b) => Object.keys(COSMETICS).every(name => (a?.[name] ?? null) === (b?.[name] ?? null));

// {avatar, banner, decoration, nameplate} -> invisible text ("" when there's nothing to share)
const encodeProfile = links => {
    const parts = Object.entries(COSMETICS).filter(([name]) => links[name]).map(([name, {key}]) => key + packLink(links[name]));
    if (!parts.length) return "";
    return [...CODE_PREFIX + parts.join(" ")].map(c => String.fromCodePoint(TAG_BASE + c.charCodeAt(0))).join("");
};

const decodeRun = run => [...run].map(c => String.fromCharCode(c.codePointAt(0) - TAG_BASE)).join("");

// bio -> {avatar, banner, decoration, nameplate} (nulls when absent)
const decodeProfile = bio => {
    const found = emptyCosmetics();
    for (const [run] of (bio ?? "").matchAll(TAG_RUN)) {
        const text = decodeRun(run);
        if (!text.startsWith(CODE_PREFIX)) continue;
        for (const part of text.slice(CODE_PREFIX.length).split(" ")) {
            if (part[1] === "/") {
                found.avatar = unpackLink(part); // 2.2.0 format: just the avatar link
                continue;
            }
            const entry = Object.entries(COSMETICS).find(([, {key}]) => key === part[0]);
            if (entry) found[entry[0]] = unpackLink(part.slice(1));
        }
        break;
    }
    return found;
};

const stripProfileCode = bio => (bio ?? "").replace(TAG_RUN, run => decodeRun(run).startsWith(CODE_PREFIX) ? "" : run);

// --- UI strings ---
const STRINGS = {
    en: {
        spoofNitro: ["Spoof Nitro", "Unlocks 1080p/source @ 60fps screensharing and the emoji picker. Needed for the emote bypass."],
        emojiBypass: ["Nitro Emotes Bypass", "Sends emotes you can't use as image links."],
        emojiSize: ["Emote Size", "Size of the linked emote image."],
        streamFps: ["Stream FPS (experimental)", "Replaces 60 fps when you pick 60 in the stream settings. Restart the stream to apply. Discord's servers may still cap it at 60."],
        streamFpsDefault: "Discord default",
        voiceBitrate: ["Voice Bitrate (experimental)", "Bitrate of your microphone in voice channels, DM calls and of your stream's sound. Discord normally sends 64 kbps (DMs, servers without boosts). Applies right away. Above ~128 kbps the difference in voice is small."],
        voiceBitrateDefault: "Discord default",
        clientsidePfp: ["Custom Avatar", "Replaces your avatar with the image below."],
        pfpUrl: ["Avatar Link", "Direct http(s) link to an image or GIF, e.g. https://i.imgur.com/abc.gif. Short links leave more room in your About Me."],
        customBanner: ["Custom Profile Banner", "Shows the image below as the background at the top of your profile."],
        bannerUrl: ["Banner Link", "Direct http(s) link to an image or GIF, best in 5:2 proportions (e.g. 600×240)."],
        customDecoration: ["Custom Avatar Frame", "Draws the image below around your avatar everywhere, like Discord's avatar decorations."],
        decorationUrl: ["Avatar Frame Link", "Square PNG or GIF with a transparent middle (e.g. 288×288). The avatar sits in the centre, the frame sticks out a bit around it."],
        customNameplate: ["Custom Nameplate", "Shows the image below behind your name in the server member list and DMs, like Discord's nameplates."],
        nameplateUrl: ["Nameplate Link", "Wide image or GIF, about 6:1 (e.g. 480×80)."],
        shareAvatar: ["Show my cosmetics to other NitroPerks users", "Adds an invisible code to your About Me. Other NitroPerks users see your custom avatar, banner, avatar frame and nameplate, everyone else sees your normal profile."],
        showShared: ["Show cosmetics of other NitroPerks users", "Their avatars, banners, frames and nameplates appear after Discord loads the person's profile once (open it or chat in DMs), then they are remembered."],
        publishing: "Saving to About Me…",
        published: "Done! Other NitroPerks users will see your profile.",
        unpublished: "Removed the code from your About Me.",
        needLink: "Turn on at least one cosmetic (avatar, banner, frame or nameplate) and paste a valid link first.",
        noProfile: "Couldn't load your profile, nothing was changed. Try again in a minute.",
        stripped: "Discord removed the hidden code from your About Me, sharing doesn't work right now.",
        saveFailed: "Couldn't save About Me: ",
        tooLong: "About Me is too long for the code. Shorten it or use a shorter link (e.g. i.imgur.com).",
        paste: "Paste",
        clear: "Clear",
        catalogOpen: "Choose from catalog ▾",
        catalogClose: "Hide catalog ▴",
        catalogShopSource: "Discord's own frames and nameplates from the shop. Click one to use it.",
        catalogGifSource: "GIFs from Discord's GIF search (Tenor). Popular ones are shown first — type a word and press Find.",
        catalogFilter: "Filter by name",
        catalogSearch: "Search GIFs, e.g. dota",
        catalogFind: "Find",
        catalogLoading: "Loading…",
        catalogEmpty: "Nothing found.",
        catalogFailed: "Couldn't load the catalog: {0}",
        catalogMore: "Showing {0} of {1} — type in the filter to narrow it down.",
        checking: "Checking the image…",
        imageOk: "✓ Image loads ({0}×{1})",
        imageBad: "✗ No image at this link. You need a direct link to the picture itself (usually ends with .png, .jpg or .gif), e.g. https://i.imgur.com/abc.png, not a page like imgur.com/abc.",
        notLink: "✗ This is not a link. It should start with https://",
        discordLink: "⚠ The image loads, but this is a Discord attachment link: it stops working on {0} and is too long to share with other users. Upload the image to imgur.com and use the direct link (i.imgur.com/….gif).",
        missing: "NitroPerks: Discord modules not found ({0}), some features are off.",
        noEngine: "NitroPerks: media engine not found, custom stream FPS and voice bitrate are off."
    },
    ru: {
        spoofNitro: ["Подмена Nitro", "Открывает стрим 1080p/исходное качество и 60 fps, а также выбор любых эмодзи. Нужна для обхода эмодзи."],
        emojiBypass: ["Обход эмодзи Nitro", "Недоступные вам эмодзи отправляются ссылками на картинку."],
        emojiSize: ["Размер эмодзи", "Размер картинки эмодзи в сообщении."],
        streamFps: ["Частота кадров стрима (эксперимент)", "Заменяет 60 fps, когда вы выбираете 60 в настройках стрима. Чтобы применить, перезапустите стрим. Серверы Discord могут всё равно ограничить до 60."],
        streamFpsDefault: "Как в Discord",
        voiceBitrate: ["Битрейт голоса (эксперимент)", "Битрейт вашего микрофона в голосовых каналах, личных звонках и звука вашего стрима. Обычно Discord отправляет 64 кбит/с (ЛС, серверы без бустов). Применяется сразу. Выше ~128 кбит/с разница в голосе уже небольшая."],
        voiceBitrateDefault: "Как в Discord",
        clientsidePfp: ["Своя аватарка", "Заменяет вашу аватарку на картинку по ссылке ниже."],
        pfpUrl: ["Ссылка на аватарку", "Прямая ссылка на картинку или GIF, например https://i.imgur.com/abc.gif. Чем короче ссылка, тем больше места останется в «Обо мне»."],
        customBanner: ["Свой баннер профиля", "Показывает картинку по ссылке ниже фоном в шапке вашего профиля."],
        bannerUrl: ["Ссылка на баннер", "Прямая ссылка на картинку или GIF, лучше в пропорциях 5:2 (например, 600×240)."],
        customDecoration: ["Своя рамка аватарки", "Рисует картинку по ссылке ниже вокруг вашей аватарки везде, как украшения аватара в Discord."],
        decorationUrl: ["Ссылка на рамку", "Квадратный PNG или GIF с прозрачной серединой (например, 288×288). Аватарка встаёт в центр, рамка немного выступает вокруг неё."],
        customNameplate: ["Своя подложка ника", "Показывает картинку по ссылке ниже за вашим ником в списке участников сервера и в ЛС, как таблички с именем в Discord."],
        nameplateUrl: ["Ссылка на подложку", "Широкая картинка или GIF, примерно 6:1 (например, 480×80)."],
        shareAvatar: ["Показывать мою косметику пользователям NitroPerks", "Добавляет невидимый код в «Обо мне». Пользователи NitroPerks увидят вашу аватарку, баннер, рамку и подложку ника, остальные — обычный профиль."],
        showShared: ["Показывать косметику других пользователей NitroPerks", "Аватарки, баннеры, рамки и подложки появятся, когда Discord один раз загрузит профиль человека (откройте его или напишите в ЛС), дальше запоминаются."],
        publishing: "Сохраняю в «Обо мне»…",
        published: "Готово! Пользователи NitroPerks увидят ваш профиль.",
        unpublished: "Код убран из «Обо мне».",
        needLink: "Сначала включите хотя бы одну косметику (аватарку, баннер, рамку или подложку) и вставьте рабочую ссылку.",
        noProfile: "Не удалось загрузить ваш профиль, ничего не изменено. Попробуйте через минуту.",
        stripped: "Discord удалил скрытый код из «Обо мне», делиться аватаркой сейчас не получится.",
        saveFailed: "Не удалось сохранить «Обо мне»: ",
        tooLong: "В «Обо мне» не хватает места для кода. Сократите текст или возьмите ссылку покороче (например, i.imgur.com).",
        paste: "Вставить",
        clear: "Очистить",
        catalogOpen: "Выбрать из каталога ▾",
        catalogClose: "Скрыть каталог ▴",
        catalogShopSource: "Официальные рамки и подложки Discord из магазина. Нажмите на понравившуюся, чтобы поставить её.",
        catalogGifSource: "GIF из поиска Discord (Tenor). Сначала показаны популярные — введите слово и нажмите «Найти».",
        catalogFilter: "Фильтр по названию",
        catalogSearch: "Поиск GIF, например dota",
        catalogFind: "Найти",
        catalogLoading: "Загружаю…",
        catalogEmpty: "Ничего не нашлось.",
        catalogFailed: "Не удалось загрузить каталог: {0}",
        catalogMore: "Показано {0} из {1} — введите часть названия в фильтр, чтобы сузить список.",
        checking: "Проверяю картинку…",
        imageOk: "✓ Картинка загружается ({0}×{1})",
        imageBad: "✗ По ссылке нет картинки. Нужна прямая ссылка на саму картинку (обычно заканчивается на .png, .jpg или .gif), например https://i.imgur.com/abc.png, а не на страницу вроде imgur.com/abc.",
        notLink: "✗ Это не ссылка. Она должна начинаться с https://",
        discordLink: "⚠ Картинка загружается, но это ссылка на вложение Discord: она перестанет работать {0} и слишком длинная, чтобы поделиться ею с другими. Загрузите картинку на imgur.com и возьмите прямую ссылку (i.imgur.com/….gif).",
        missing: "NitroPerks: не найдены модули Discord ({0}), часть функций отключена.",
        noEngine: "NitroPerks: не найден медиадвижок, своя частота кадров стрима и битрейт голоса отключены."
    }
};

module.exports = class NitroPerks {
    constructor(meta) {
        this.meta = meta;
        this.api = new BdApi(meta.name);
        this.spoofed = new WeakSet();
        this.real = null; // {premiumType, perks} of the account before spoofing
        this.originalBitrates = new WeakMap(); // connection -> bitrate Discord asked for
        this.onProfileFetched = this.onProfileFetched.bind(this);
        this.onProfileUpdated = this.onProfileUpdated.bind(this);
    }

    start() {
        this.settings = {...DEFAULT_SETTINGS, ...this.api.Data.load("settings")};
        this.shared = this.api.Data.load("sharedProfiles") ?? {}; // userId -> {avatar, banner, seen}

        const {Webpack} = this.api;
        const filter = Webpack.Filters.byKeys ?? Webpack.Filters.byProps;
        const byKeys = (...keys) => Webpack.getModule(filter(...keys), {searchExports: true});
        // Exported functions are found by their source, in one pass over all modules (own filter instead of
        // Filters.byStrings, which didn't find getDisplayProfile on the live client).
        const wanted = {
            fetchProfile: ["USER_PROFILE_FETCH_START", "USER_PROFILE_FETCH_SUCCESS"],
            saveProfile: ["USER_PROFILE_UPDATE_START", "USER_PROFILE_UPDATE_SUCCESS"],
            getDisplayProfile: [".getUserProfile(", ".getGuildMemberProfile(", "arguments[2]"],
            fetchCollectibles: ["COLLECTIBLES_CATEGORIES_FETCH_SUCCESS", "COLLECTIBLES_CATEGORIES_V2"]
        };
        const candidates = {};
        Webpack.getModule(m => {
            if (typeof m !== "function") return false;
            let source;
            try {
                source = String(m);
            } catch {
                return false;
            }
            for (const [name, strings] of Object.entries(wanted)) {
                if (strings.every(s => source.includes(s))) (candidates[name] ??= new Set()).add(m);
            }
            return false; // keep scanning
        }, {searchExports: true});
        const pick = (name, valid = () => true) => [...(candidates[name] ?? [])]
            .sort((a, b) => String(a).length - String(b).length) // shortest first: the real helpers are tiny
            .find(fn => {
                try {
                    return valid(fn);
                } catch {
                    return false;
                }
            });
        // Several big components also mention these strings: keep the one that really builds a DisplayProfile.
        // Only short functions are test-called, so no component or fetching code ever runs.
        const isDisplayProfileFactory = fn => String(fn).length < 1000 && typeof this.displayProfilePrototype(fn)?.getBannerURL === "function";
        const found = {
            fetchProfile: pick("fetchProfile"),
            saveProfile: pick("saveProfile"),
            getDisplayProfile: pick("getDisplayProfile", isDisplayProfileFactory),
            fetchCollectibles: pick("fetchCollectibles", fn => String(fn).length < 4000) // never test-called
        };
        this.debug("candidates:", Object.fromEntries(Object.entries(candidates).map(([k, v]) => [k, v.size])));
        this.UserStore = Webpack.getStore("UserStore");
        this.ChannelStore = Webpack.getStore("ChannelStore");
        this.EmojiStore = Webpack.getStore("EmojiStore");
        this.UserProfileStore = Webpack.getStore("UserProfileStore");
        this.LocaleStore = Webpack.getStore("LocaleStore");
        this.MediaEngineStore = Webpack.getStore("MediaEngineStore");
        this.MessageActions = byKeys("_sendMessage", "editMessage", "sendMessage");
        this.AvatarUtils = byKeys("getUserAvatarURL", "getGuildMemberAvatarURLSimple");
        this.Dispatcher = byKeys("dispatch", "subscribe", "unsubscribe", "isDispatching");
        this.fetchProfile = found.fetchProfile;
        this.saveProfile = found.saveProfile;
        this.getDisplayProfile = found.getDisplayProfile;
        // for the picture catalog in the settings
        this.fetchCollectibles = found.fetchCollectibles;
        this.CollectiblesStore = Webpack.getStore("CollectiblesCategoryStore");
        this.HTTP = Webpack.getModule(m => m && typeof m === "object" && Object.keys(m).length === 5 &&
            ["get", "post", "put", "patch", "del"].every(k => typeof m[k] === "function"), {searchExports: true});

        const missing = ["UserStore", "ChannelStore", "MessageActions", "AvatarUtils"].filter(name => !this[name]);
        if (missing.length) this.toast(this.t("missing").replace("{0}", missing.join(", ")), "error");

        this.Dispatcher?.subscribe("USER_PROFILE_FETCH_SUCCESS", this.onProfileFetched);
        this.Dispatcher?.subscribe("USER_PROFILE_UPDATE_SUCCESS", this.onProfileUpdated);
        this.installKeyDiagnostics();
        this.debug(`v${this.meta.version ?? "?"} started`, {
            customBanner: this.settings.customBanner, bannerLink: isValidUrl(this.settings.bannerUrl),
            clientsidePfp: this.settings.clientsidePfp, avatarLink: isValidUrl(this.settings.pfpUrl),
            customDecoration: this.settings.customDecoration, decorationLink: isValidUrl(this.settings.decorationUrl),
            customNameplate: this.settings.customNameplate, nameplateLink: isValidUrl(this.settings.nameplateUrl),
            shareAvatar: this.settings.shareAvatar, showShared: this.settings.showShared,
            UserProfileStore: !!this.UserProfileStore, fetchProfile: !!this.fetchProfile, saveProfile: !!this.saveProfile,
            getDisplayProfile: !!this.getDisplayProfile, Dispatcher: !!this.Dispatcher
        });
        this.reapply();
    }

    stop() {
        this.Dispatcher?.unsubscribe("USER_PROFILE_FETCH_SUCCESS", this.onProfileFetched);
        this.Dispatcher?.unsubscribe("USER_PROFILE_UPDATE_SUCCESS", this.onProfileUpdated);
        clearTimeout(this.shareTimer);
        clearTimeout(this.cacheTimer);
        clearTimeout(this.collectiblesTimer);
        Object.values(this.inputTimers ?? {}).forEach(clearTimeout);
        for (const entry of this.images?.values() ?? []) if (entry.blob) URL.revokeObjectURL(entry.blob);
        this.images?.clear();
        this.api.Patcher.unpatchAll();
        this.removeDomPatches();
        this.removeKeyDiagnostics();
        this.restoreUser();
        this.restoreBitrates();
        this.rerender(); // drop our user copies from what's on screen
    }

    t(key) {
        const lang = this.LocaleStore?.locale?.startsWith("ru") ? "ru" : "en";
        return STRINGS[lang][key] ?? STRINGS.en[key];
    }

    toast(text, type = "info") {
        this.api.UI.showToast(text, {type});
    }

    saveSettings() {
        this.api.Data.save("settings", this.settings);
        this.reapply();
    }

    // Never throws: one broken patch (Discord update) must not take down the rest of the plugin,
    // and BetterDiscord only updates its inputs after our onChange returns.
    reapply() {
        try {
            this.api.Patcher.unpatchAll();
            this.removeDomPatches();
            clearTimeout(this.collectiblesTimer);
            this.collectiblesRetries = 0;
            this.restoreUser();
            this.applyPatches();
        } catch (e) {
            console.error("[NitroPerks] applying settings failed", e);
        }
    }

    updateSetting(id, value) {
        this.settings[id] = value;
        this.saveSettings();
        // Keep About Me in sync with what the user sees: sharing on/off, a cosmetic on/off or a new link.
        const profileFields = Object.values(COSMETICS).flatMap(({toggle, link}) => [toggle, link]);
        if (id === "shareAvatar" || (this.settings.shareAvatar && profileFields.includes(id))) {
            this.scheduleShareSync(id);
        }
    }

    applyPatches() {
        const {Patcher} = this.api;

        if (this.UserStore) {
            const current = this.UserStore.getCurrentUser();
            if (current) this.real = {premiumType: current.premiumType, perks: current.perks};
            if (this.settings.spoofNitro) {
                Patcher.after(this.UserStore, "getCurrentUser", (_, __, user) => this.spoofUser(user));
                this.UserStore.getCurrentUser();
            }
        }

        if (this.settings.streamFps > 0 || this.settings.voiceBitrate > 0) {
            // The connection class isn't exported: patch its prototype through the engine instead,
            // on connections that already exist and on every new one from engine.connect().
            const engine = this.mediaEngine();
            if (engine?.connect) {
                this.patchedConnections = new WeakSet();
                engine.eachConnection?.(conn => this.patchConnection(conn));
                Patcher.after(engine, "connect", (_, __, conn) => this.patchConnection(conn));
            } else {
                this.toast(this.t("noEngine"), "error");
            }
        }
        if (!(this.settings.voiceBitrate > 0)) this.restoreBitrates();

        if (this.settings.emojiBypass && this.MessageActions) {
            // _sendMessage(channelId, {content, validNonShortcutEmojis, invalidEmojis, tts}, options)
            Patcher.before(this.MessageActions, "_sendMessage", (_, [channelId, message]) => {
                if (typeof message?.content !== "string") return;
                message.content = this.replaceEmojis(channelId, message.content, message.validNonShortcutEmojis ?? []);
            });
            // editMessage(channelId, messageId, {content})
            Patcher.before(this.MessageActions, "editMessage", (_, [channelId, , message]) => {
                if (typeof message?.content !== "string") return;
                const emojis = [...message.content.matchAll(/<(a?):([^:<>\s]+):(\d{17,20})>/g)].map(([, animated, name, id]) =>
                    this.EmojiStore?.getCustomEmojiById(id) ?? {id, name, animated: animated === "a"}
                );
                message.content = this.replaceEmojis(channelId, message.content, emojis);
            });
        }

        if (this.AvatarUtils && (this.ownAvatar() || this.settings.showShared)) {
            const patch = (method, getId, wrap = u => u) => {
                if (typeof this.AvatarUtils[method] !== "function") return;
                Patcher.after(this.AvatarUtils, method, (_, args, ret) => {
                    const url = this.avatarFor(getId(args[0]));
                    return url ? wrap(this.displayUrl(url)) : ret;
                });
            };
            patch("getUserAvatarURL", user => user?.id);
            patch("getUserAvatarSource", user => user?.id, u => ({uri: u}));
            patch("getGuildMemberAvatarURLSimple", opts => opts?.userId);
            patch("getGuildMemberAvatarURL", member => member?.userId);
            patch("getGuildMemberAvatarSource", member => member?.userId, u => ({uri: u}));
        }

        if (this.UserProfileStore && (this.ownBanner() || this.settings.showShared)) {
            // A profile without a banner makes Discord skip the banner entirely, so hand out a Proxy that
            // reports a placeholder hash. Proxies are cached per profile object: same identity on every call
            // (no re-render loops), and Discord's in-place updates of the original stay visible.
            this.bannerProxies = new WeakMap();
            Patcher.after(this.UserProfileStore, "getUserProfile", (_, [userId], profile) => {
                if (!profile || !this.bannerFor(userId)) return profile;
                let proxy = this.bannerProxies.get(profile);
                if (!proxy) {
                    proxy = new Proxy(profile, {get: (target, key, receiver) => key === "banner" ? BANNER_PLACEHOLDER : Reflect.get(target, key, receiver)});
                    this.bannerProxies.set(profile, proxy);
                    this.debugOnce(`proxy:${userId}`, "banner placeholder for", this.who(userId));
                }
                return proxy;
            });
            const proto = this.displayProfilePrototype();
            this.debug("banner patch:", {getDisplayProfile: typeof this.getDisplayProfile, prototype: !!proto, getBannerURL: typeof proto?.getBannerURL});
            if (proto?.getBannerURL) {
                Patcher.after(proto, "getBannerURL", (profile, _, ret) => {
                    const url = this.bannerFor(profile?.userId);
                    this.debugOnce(`banner:${profile?.userId}:${url}`, "getBannerURL for", this.who(profile?.userId), "->", url ?? `(not ours) ${ret}`);
                    return url ? this.displayUrl(url) : ret;
                });
            }
            this.installDomPatches();
        }

        if (this.UserStore && (this.ownDecoration() || this.ownNameplate() || this.settings.showShared)) {
            this.patchUserCollectibles();
            this.installDomPatches();
            this.patchUserIdentities();
            // Discord memoizes nameplates/frames per user object (useMemo(…, [member, user])), so lists drawn
            // before the plugin started keep "none" until the user object changes: hand out fresh objects.
            const me = this.UserStore.getCurrentUser()?.id;
            const ids = Object.entries(this.shared ?? {}).filter(([, s]) => s.decoration || s.nameplate).map(([id]) => id);
            if (me && (this.ownDecoration() || this.ownNameplate())) ids.push(me);
            this.bumpUsers(ids);
        }
    }

    // For users whose frame/nameplate changed, UserStore.getUser/getCurrentUser return a copy of the record
    // (same class, same data) — a new object identity, so Discord's memoized hooks re-read the cosmetics.
    patchUserIdentities() {
        this.userRevs ??= new Map();
        this.userCopies = new WeakMap();
        const derive = user => {
            const rev = user?.id != null ? this.userRevs.get(user.id) : undefined;
            if (!rev || typeof user.constructor !== "function") return user;
            const cached = this.userCopies.get(user);
            if (cached?.rev === rev) return cached.copy;
            let copy;
            try {
                copy = new user.constructor({...user});
            } catch {
                return user;
            }
            this.userCopies.set(user, {rev, copy});
            return copy;
        };
        for (const method of ["getUser", "getCurrentUser"]) {
            if (typeof this.UserStore[method] === "function") this.api.Patcher.after(this.UserStore, method, (_, __, user) => derive(user));
        }
    }

    bumpUsers(ids) {
        if (!ids.length || !this.userRevs) return;
        for (const id of ids) this.userRevs.set(id, (this.userRevs.get(id) ?? 0) + 1);
        this.rerender();
    }

    // Avatar frames and nameplates: the User class has getters avatarDecoration (→ avatarDecorationData) and
    // nameplate (→ collectibles.nameplate). Overriding them on the prototype gives every user with a custom
    // frame/nameplate a fake collectible with a placeholder skuId; Discord builds its asset URL from that
    // (cdn…/media/v1/collectibles-shop/<skuId>/<static|animated|video>) and the DOM safety net swaps the link in.
    patchUserCollectibles() {
        if (this.protoRestores?.length) return;
        this.protoRestores = [];
        const user = this.UserStore.getCurrentUser();
        const proto = user && Object.getPrototypeOf(user);
        if (!proto || proto === Object.prototype) {
            // not logged in yet: try again a bit later (a few times)
            this.collectiblesRetries = (this.collectiblesRetries ?? 0) + 1;
            if (this.collectiblesRetries <= 10) {
                clearTimeout(this.collectiblesTimer);
                this.collectiblesTimer = setTimeout(() => this.patchUserCollectibles(), 3000);
            }
            return this.debug("collectibles: no User prototype yet");
        }
        this.collectiblesRetries = 0;
        this.fakeCollectibles = new Map();
        const plugin = this;
        const done = [];
        for (const key of ["avatarDecoration", "nameplate"]) {
            const desc = Object.getOwnPropertyDescriptor(proto, key);
            if (!desc?.get || !desc.configurable) continue;
            Object.defineProperty(proto, key, {
                ...desc,
                get() {
                    return plugin.fakeCollectible(key, this?.id) ?? desc.get.call(this);
                }
            });
            this.protoRestores.push(() => Object.defineProperty(proto, key, desc));
            done.push(key);
        }
        this.debug("collectibles patch:", {patched: done});
    }

    // Same object for the same user and link, so React doesn't re-render on every read.
    fakeCollectible(key, userId) {
        const url = key === "avatarDecoration" ? this.decorationFor(userId) : this.nameplateFor(userId);
        if (!url) return null;
        const cacheKey = `${key}:${userId}:${url}`;
        let item = this.fakeCollectibles?.get(cacheKey);
        if (!item) {
            item = key === "avatarDecoration"
                ? {asset: BANNER_PLACEHOLDER, skuId: fakeSkuId(userId, "f")}
                : {skuId: fakeSkuId(userId, "n"), src: BANNER_PLACEHOLDER, imgAlt: "", palette: {name: "nitroperks", darkBackground: "#000000", lightBackground: "#ffffff"}};
            this.fakeCollectibles?.set(cacheKey, item);
            this.debugOnce(`fake:${cacheKey}`, key, "for", this.who(userId));
        }
        return item;
    }

    // Safety net: URLs built from our placeholders (cdn…/banners/<id>/nitroperks.png for banners,
    // cdn…/collectibles-shop/nitroperks-<id>-<f|n>/<format> for frames and nameplates — they exist only for
    // cosmetics we fake) get the real link where they land: <img src>, src/style attributes, CSS backgrounds.
    // <video> can't play a GIF, so a placeholder video source becomes the element's background image instead.
    installDomPatches() {
        if (this.domRestores?.length || typeof window === "undefined" || typeof Element === "undefined") return;
        this.domRestores = [];
        const bannerUrl = new RegExp(`https?://[^"')\\s]+/banners/(\\d+)/${BANNER_PLACEHOLDER}\\.[a-z]+(\\?[^"')\\s]*)?`, "g");
        const collectibleUrl = new RegExp(`https?://[^"')\\s]+/collectibles-shop/${COLLECTIBLE_PREFIX}(\\d+)-([fn])/[a-z]+(\\?[^"')\\s]*)?`, "g");
        // reapply: re-runs the original assignment once a proxied image is downloaded (see displayUrl)
        const fix = (value, reapply) => {
            if (typeof value !== "string") return value;
            if (value.includes(`/${BANNER_PLACEHOLDER}.`)) {
                value = value.replace(bannerUrl, (match, userId) => {
                    const url = this.bannerFor(userId);
                    this.debugOnce(`dom:b:${userId}:${url}`, "DOM banner for", this.who(userId), "->", url ?? "(none)");
                    return url ? this.displayUrl(url, reapply) : match;
                });
            }
            if (value.includes(`/${COLLECTIBLE_PREFIX}`)) {
                value = value.replace(collectibleUrl, (match, userId, kind) => {
                    const url = kind === "f" ? this.decorationFor(userId) : this.nameplateFor(userId);
                    this.debugOnce(`dom:${kind}:${userId}:${url}`, `DOM ${kind === "f" ? "frame" : "nameplate"} for`, this.who(userId), "->", url ?? "(none)");
                    return url ? this.displayUrl(url, reapply) : match;
                });
            }
            return value;
        };
        const asBackground = (el, url) => {
            if (!el?.style) return;
            el.style.backgroundImage = `url("${url}")`;
            el.style.backgroundSize = "cover";
            el.style.backgroundPosition = "center";
            el.style.backgroundRepeat = "no-repeat";
        };
        // for <video>/<source>: returns the value to really set ("" when we took over)
        const fixMedia = (el, value, reapply) => {
            const fixed = fix(value, reapply);
            if (fixed === value) return value;
            if (el.tagName === "SOURCE") {
                const apply = () => asBackground(el.parentElement, fixed);
                el.parentElement ? apply() : setTimeout(apply, 0);
            } else {
                asBackground(el, fixed);
            }
            return "";
        };
        const wrapSetter = (proto, key, transform = (el, value, reapply) => fix(value, reapply)) => {
            const desc = proto && Object.getOwnPropertyDescriptor(proto, key);
            if (!desc?.set || !desc.configurable) return;
            Object.defineProperty(proto, key, {
                ...desc,
                set(value) {
                    desc.set.call(this, transform(this, value, () => { this[key] = value; }));
                }
            });
            this.domRestores.push(() => Object.defineProperty(proto, key, desc));
        };
        const wrapMethod = (proto, key, wrap) => {
            const original = proto?.[key];
            if (typeof original !== "function") return;
            proto[key] = wrap(original);
            this.domRestores.push(() => { proto[key] = original; });
        };
        wrapSetter(window.HTMLImageElement?.prototype, "src");
        wrapSetter(window.HTMLImageElement?.prototype, "srcset");
        wrapSetter(window.HTMLMediaElement?.prototype, "src", fixMedia);
        wrapSetter(window.HTMLSourceElement?.prototype, "src", fixMedia);
        wrapSetter(window.HTMLVideoElement?.prototype, "poster");
        // Newer Chromium keeps the CSS properties on CSSStyleProperties, older on CSSStyleDeclaration.
        for (const proto of [window.CSSStyleProperties?.prototype, window.CSSStyleDeclaration?.prototype]) {
            for (const key of ["backgroundImage", "background", "background-image"]) wrapSetter(proto, key);
        }
        wrapSetter(window.CSSStyleDeclaration?.prototype, "cssText");
        wrapMethod(window.CSSStyleDeclaration?.prototype, "setProperty", original => function (name, value, ...rest) {
            return original.call(this, name, fix(value, () => this.setProperty(name, value, ...rest)), ...rest);
        });
        wrapMethod(Element.prototype, "setAttribute", original => function (name, value) {
            const reapply = () => this.setAttribute(name, value);
            if (name === "src" && (this.tagName === "VIDEO" || this.tagName === "SOURCE")) return original.call(this, name, fixMedia(this, value, reapply));
            return original.call(this, name, ["src", "srcset", "style", "poster", "href"].includes(name) ? fix(value, reapply) : value);
        });
        this.debug("DOM safety net:", {patched: this.domRestores.length, CSSStyleProperties: !!window.CSSStyleProperties});
    }

    // --- images from hosts the Discord window can't reach ---
    // Chromium connects to Cloudflare sites with ECH, which is blocked on some networks (e.g. in Russia), so
    // images from hosts like ugc.decor.fieryflames.dev hang forever in Discord while plain HTTPS works.
    // Those are downloaded through BetterDiscord's Net.fetch (Node, no ECH, no CSP) and shown as blob: URLs.
    // Discord's own CDN, tenor and imgur load directly.

    isDirectImage(url) {
        try {
            if (/^(blob|data):/.test(url)) return true;
            return /(^|\.)(discordapp\.com|discordapp\.net|discord\.com|tenor\.com|tenor\.co|imgur\.com)$/.test(new URL(url).hostname);
        } catch {
            return true;
        }
    }

    // URL to use right now; when a proxied image finishes, onReady runs (to re-set the element) and stores re-render
    displayUrl(url, onReady) {
        const net = this.api.Net ?? BdApi.Net;
        if (!url || this.isDirectImage(url) || typeof net?.fetch !== "function") return url;
        this.images ??= new Map();
        const entry = this.images.get(url);
        if (entry?.blob) return entry.blob;
        if (entry?.failed) return url;
        if (onReady) (entry ?? this.startImageLoad(url)).waiters.add(onReady);
        else if (!entry) this.startImageLoad(url);
        return url;
    }

    // Promise of a displayable URL (blob: for proxied hosts); used by the link check in the settings
    resolveImage(url) {
        if (this.isDirectImage(url) || typeof (this.api.Net ?? BdApi.Net)?.fetch !== "function") return Promise.resolve(url);
        this.images ??= new Map();
        return (this.images.get(url) ?? this.startImageLoad(url)).promise;
    }

    startImageLoad(url) {
        const net = this.api.Net ?? BdApi.Net;
        const entry = {waiters: new Set(), blob: null, failed: false};
        this.images.set(url, entry);
        entry.promise = (async () => {
            const res = await net.fetch(url, {timeout: 30000});
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const type = res.headers.get("content-type") ?? "";
            if (!type.startsWith("image/")) throw new Error(`not an image (${type || "no type"})`);
            const blob = await res.blob();
            if (blob.size > 10 * 1024 * 1024) throw new Error(`too big (${Math.round(blob.size / 1048576)} MB)`);
            entry.blob = URL.createObjectURL(blob);
            this.debug("image proxied:", url, `${Math.round(blob.size / 1024)} KB`);
            const waiters = [...entry.waiters];
            entry.waiters.clear();
            for (const reapply of waiters) {
                try {
                    reapply();
                } catch {}
            }
            this.rerender();
            return entry.blob;
        })();
        entry.promise.catch(e => {
            entry.failed = true;
            entry.waiters.clear();
            this.debug("image proxy failed:", url, String(e?.message ?? e));
        });
        return entry;
    }

    // --- picture catalog for the settings: Discord's own shop art and GIF search ---
    // Everything comes from Discord itself (shop catalog, /gifs search) and lives on hosts that load directly.

    // {decorations: [{name, url, thumb}], nameplates: [...]}
    async shopCatalog() {
        if (this.shopCache) return this.shopCache;
        const DECO = "https://cdn.discordapp.com/avatar-decoration-presets/";
        const collect = source => {
            const out = {decorations: [], nameplates: []};
            const seenObjects = new WeakSet(), seenUrls = new Set();
            const walk = (obj, name, depth) => {
                if (!obj || typeof obj !== "object" || depth > 8 || seenObjects.has(obj)) return;
                seenObjects.add(obj);
                if (obj instanceof Map) return walk([...obj.values()], name, depth + 1);
                if (Array.isArray(obj)) return obj.forEach(x => walk(x, name, depth + 1));
                if (typeof obj.asset === "string" && (obj.type === 0 || obj.type === 2)) {
                    const item = obj.type === 0
                        ? {name: obj.label || name || "", url: `${DECO}${obj.asset}.png?passthrough=true`, thumb: `${DECO}${obj.asset}.png?size=96&passthrough=false`}
                        : {name: obj.label || name || "", url: `https://cdn.discordapp.com/assets/collectibles/${obj.asset}static.png`};
                    item.thumb ??= item.url;
                    if (!seenUrls.has(item.url)) {
                        seenUrls.add(item.url);
                        out[obj.type === 0 ? "decorations" : "nameplates"].push(item);
                    }
                    return;
                }
                const nextName = typeof obj.name === "string" ? obj.name : name;
                for (const value of Object.values(obj)) walk(value, nextName, depth + 1);
            };
            walk(source, "", 0);
            return out;
        };
        const empty = c => !c.decorations.length && !c.nameplates.length;

        let catalog = collect(this.CollectiblesStore?.products);
        if (empty(catalog) && this.fetchCollectibles && this.CollectiblesStore?.addChangeListener) {
            // the same request Discord makes when you open the shop
            await new Promise(resolve => {
                const store = this.CollectiblesStore;
                const done = () => {
                    clearTimeout(timer);
                    store.removeChangeListener?.(onChange);
                    resolve();
                };
                const onChange = () => { if (!store.isFetchingCategories) done(); };
                const timer = setTimeout(done, 15000);
                store.addChangeListener(onChange);
                Promise.resolve(this.fetchCollectibles({})).catch(done);
            });
            catalog = collect(this.CollectiblesStore.products);
        }
        if (empty(catalog) && this.HTTP) {
            try {
                const res = await this.HTTP.get({url: "/collectibles-categories/v2", oldFormErrors: true});
                catalog = collect(res?.body);
            } catch (e) {
                this.debug("shop catalog request failed:", String(e?.message ?? e?.status ?? e));
            }
        }
        this.debug("shop catalog:", {decorations: catalog.decorations.length, nameplates: catalog.nameplates.length});
        if (!empty(catalog)) this.shopCache = catalog;
        return catalog;
    }

    // GIFs via Discord's GIF picker API (Tenor); empty query = trending
    async searchGifs(query) {
        if (!this.HTTP) throw new Error("no HTTP module");
        const res = await this.HTTP.get({
            url: query ? "/gifs/search" : "/gifs/trending-gifs",
            query: {q: query || undefined, media_format: "tinygif", provider: "tenor", locale: this.LocaleStore?.locale ?? "en-US", limit: 40},
            oldFormErrors: true
        });
        const list = Array.isArray(res?.body) ? res.body : res?.body?.gifs ?? res?.body?.results ?? [];
        const https = u => typeof u === "string" && u.startsWith("//") ? "https:" + u : u;
        return list
            .map(g => ({name: g.title ?? "", url: https(g.gif_src ?? g.src), thumb: https(g.src ?? g.gif_src)}))
            .filter(g => isValidUrl(g.url));
    }

    rerender() {
        for (const store of [this.UserStore, this.UserProfileStore]) {
            try {
                store?.emitChange?.();
            } catch {}
        }
    }

    removeDomPatches() {
        [...(this.domRestores ?? []).splice(0), ...(this.protoRestores ?? []).splice(0)].reverse().forEach(restore => {
            try {
                restore();
            } catch {}
        });
    }

    // Where keystrokes in our inputs get to: "window" (capture, first thing), "target" (our native listener),
    // "react" (React's handler). Logged for the first keys only, to see what Discord swallows.
    noteKey(stage, e) {
        this.keyStats ??= {window: 0, target: 0, react: 0};
        this.keyStats[stage]++;
        const total = this.keyStats.window + this.keyStats.target + this.keyStats.react;
        if (total <= 24) this.debug("key", stage, JSON.stringify({key: e.key, prevented: e.defaultPrevented, stats: this.keyStats}));
    }

    installKeyDiagnostics() {
        if (this.keyDiag || typeof window === "undefined" || !window.addEventListener) return;
        this.keyDiag = e => {
            if (document.activeElement?.dataset?.nitroperks) this.noteKey("window", e);
        };
        window.addEventListener("keydown", this.keyDiag, true);
    }

    removeKeyDiagnostics() {
        if (this.keyDiag) window.removeEventListener("keydown", this.keyDiag, true);
        this.keyDiag = null;
    }

    // --- diagnostics (go to Discord's renderer log) ---

    debug(...args) {
        // Discord's log writes objects as [object Object], so flatten them
        console.info("[NitroPerks]", ...args.map(a => a && typeof a === "object" ? JSON.stringify(a) : a));
    }

    debugOnce(key, ...args) {
        this.logged ??= new Set();
        if (this.logged.has(key) || this.logged.size > 200) return;
        this.logged.add(key);
        this.debug(...args);
    }

    who(userId) {
        return this.isMe(userId) ? "me" : userId ? "user …" + String(userId).slice(-4) : String(userId);
    }

    // DisplayProfile isn't exported; getDisplayProfile(userId, guildId, [UserStore, UserProfileStore]) is.
    // Called with stub stores it hands us an instance, i.e. the prototype to patch.
    displayProfilePrototype(factory = this.getDisplayProfile) {
        if (typeof factory !== "function") return null;
        try {
            const sample = factory("0", null, [
                {getUser: () => ({})},
                {getUserProfile: () => ({}), getGuildMemberProfile: () => null}
            ]);
            const proto = sample && typeof sample === "object" ? Object.getPrototypeOf(sample) : null;
            return proto && proto !== Object.prototype ? proto : null;
        } catch {
            return null;
        }
    }

    // --- cosmetics: avatar, banner, avatar frame, nameplate ---

    // own link for a cosmetic when its switch is on and the link is valid
    own(name) {
        const {toggle, link} = COSMETICS[name];
        return this.settings[toggle] && isValidUrl(this.settings[link]) ? this.settings[link] : null;
    }

    // what to show for a user: mine from the settings, others' from their About Me code
    cosmeticFor(name, userId) {
        if (userId == null) return null;
        if (this.isMe(userId)) return this.own(name);
        return this.settings.showShared ? this.shared[userId]?.[name] ?? null : null;
    }

    ownAvatar() { return this.own("avatar"); }
    ownBanner() { return this.own("banner"); }
    ownDecoration() { return this.own("decoration"); }
    ownNameplate() { return this.own("nameplate"); }
    avatarFor(userId) { return this.cosmeticFor("avatar", userId); }
    bannerFor(userId) { return this.cosmeticFor("banner", userId); }
    decorationFor(userId) { return this.cosmeticFor("decoration", userId); }
    nameplateFor(userId) { return this.cosmeticFor("nameplate", userId); }

    isMe(userId) {
        return userId != null && userId === this.UserStore?.getCurrentUser()?.id;
    }

    onProfileFetched({userProfile}) {
        const userId = userProfile?.user?.id;
        if (userId) this.learn(userId, userProfile.user_profile?.bio);
    }

    onProfileUpdated({userId, guildId, bio}) {
        if (userId && guildId == null && typeof bio === "string") this.learn(userId, bio);
    }

    learn(userId, bio) {
        const links = decodeProfile(bio);
        const before = this.shared[userId];
        if (sameCosmetics(before, links)) return;
        if (Object.values(links).some(Boolean)) this.shared[userId] = {...links, seen: Date.now()};
        else delete this.shared[userId];
        clearTimeout(this.cacheTimer);
        this.cacheTimer = setTimeout(() => this.api.Data.save("sharedProfiles", this.shared), 2000);
        // a new frame/nameplate needs a fresh user object (memoized hooks); the rest just re-renders
        if ((before?.decoration ?? null) !== links.decoration || (before?.nameplate ?? null) !== links.nameplate) this.bumpUsers([userId]);
        else this.rerender();
    }

    // Writes (or removes) the hidden profile code in the current user's About Me.
    // trigger = the setting that changed.
    async syncShare(trigger) {
        const {shareAvatar} = this.settings;
        const names = Object.keys(COSMETICS);
        if (shareAvatar && !names.some(name => this.own(name)) && trigger === "shareAvatar") return this.toast(this.t("needLink"), "warning");
        // the edited link is still being typed: keep what's published until it becomes valid
        const edited = Object.values(COSMETICS).find(({link}) => link === trigger);
        if (edited && this.settings[edited.toggle] && !isValidUrl(this.settings[edited.link])) return;
        const want = Object.fromEntries(names.map(name => [name, shareAvatar ? this.own(name) : null]));
        const me = this.UserStore?.getCurrentUser()?.id;
        if (!me || !this.saveProfile || !this.UserProfileStore) return this.toast(this.t("noProfile"), "error");

        // Never write a bio we haven't read: the PATCH replaces the whole text.
        let profile = this.UserProfileStore.getUserProfile(me);
        if (typeof profile?.bio !== "string" || !profile.fetchEndedAt) {
            try {
                await this.fetchProfile?.(me);
            } catch {}
            profile = this.UserProfileStore.getUserProfile(me);
        }
        if (typeof profile?.bio !== "string" || profile.fetchError) return this.toast(this.t("noProfile"), "error");

        const same = sameCosmetics;
        if (same(decodeProfile(profile.bio), want)) return;
        const sharing = Object.values(want).some(Boolean);
        const bio = stripProfileCode(profile.bio) + encodeProfile(want);

        if (sharing) this.toast(this.t("publishing"));
        const res = await this.saveProfile({bio});
        const saved = res?.body?.bio;
        if (typeof saved !== "string") {
            const errors = JSON.stringify(res?.body?.errors ?? {});
            if (/BASE_TYPE_MAX_LENGTH|too long|length/i.test(errors)) return this.toast(this.t("tooLong"), "error");
            return this.toast(this.t("saveFailed") + (res?.body?.message ?? res?.status ?? "?"), "error");
        }
        if (!same(decodeProfile(saved), want)) return this.toast(this.t("stripped"), "error");
        this.toast(this.t(sharing ? "published" : "unpublished"), "success");
    }

    scheduleShareSync(trigger) {
        clearTimeout(this.shareTimer);
        this.shareTimer = setTimeout(() => this.syncShare(trigger).catch(e => console.error("[NitroPerks] share failed", e)), 1500);
    }

    // --- stream fps ---

    mediaEngine() {
        try {
            return this.MediaEngineStore?.getMediaEngine?.();
        } catch {
            return null;
        }
    }

    patchConnection(conn) {
        const proto = conn && Object.getPrototypeOf(conn);
        if (!proto) return;
        if (!this.patchedConnections.has(proto)) {
            this.patchedConnections.add(proto);
            if (this.settings.streamFps > 0 && typeof proto.setGoLiveSource === "function") {
                // setGoLiveSource({desktopDescription | cameraDescription, quality: {resolution, frameRate}})
                this.api.Patcher.before(proto, "setGoLiveSource", (_, args) => {
                    const quality = args[0]?.quality;
                    if (quality?.frameRate !== PICKER_MAX_FPS) return; // only when 60 was picked
                    args[0] = {...args[0], quality: {...quality, frameRate: this.settings.streamFps}};
                });
            }
            if (this.settings.voiceBitrate > 0 && typeof proto.setBitRate === "function") {
                // setBitRate(bps): the channel's bitrate, on connect and whenever it changes
                this.api.Patcher.before(proto, "setBitRate", (that, args) => {
                    if (!this.ownBitrateCall) this.originalBitrates.set(that, args[0]);
                    args[0] = this.settings.voiceBitrate * 1000;
                });
            }
        }
        if (this.settings.voiceBitrate > 0 && typeof conn.setBitRate === "function") {
            // Connections that existed before the plugin: what they run with now is Discord's value.
            if (!this.originalBitrates.has(conn) && typeof conn.voiceBitrate === "number") this.originalBitrates.set(conn, conn.voiceBitrate);
            this.setBitRate(conn, this.originalBitrates.get(conn) ?? DEFAULT_VOICE_BITRATE); // the patch swaps it
        }
    }

    setBitRate(conn, bitrate) {
        this.ownBitrateCall = true;
        try {
            conn.setBitRate(bitrate);
        } catch (e) {
            console.error("[NitroPerks] setBitRate failed", e);
        } finally {
            this.ownBitrateCall = false;
        }
    }

    // Back to the channel's bitrate on live connections (call only while setBitRate isn't patched).
    restoreBitrates() {
        this.mediaEngine()?.eachConnection?.(conn => {
            const original = this.originalBitrates.get(conn);
            if (original != null && conn.voiceBitrate !== original) this.setBitRate(conn, original);
            this.originalBitrates.delete(conn); // unpatched from now on: Discord's later changes land in conn.voiceBitrate
        });
    }

    // --- nitro spoof ---

    spoofUser(user) {
        if (!user || this.spoofed.has(user)) return;
        // A record we haven't touched and that isn't tier 2 is fresh data from Discord: remember it.
        // (Copies of an already spoofed record also land here with premiumType 2 — keep the old snapshot then.)
        if (user.premiumType !== PREMIUM_TIER_2 || !this.real) this.real = {premiumType: user.premiumType, perks: user.perks};
        if (this.real.premiumType === PREMIUM_TIER_2) return; // real Nitro, nothing to do
        try {
            user.premiumType = PREMIUM_TIER_2;
            user.perks = null; // otherwise the perks experiment re-checks the real bitmask
            this.spoofed.add(user);
        } catch (e) {
            console.error("[NitroPerks] Failed to spoof premiumType", e);
        }
    }

    restoreUser() {
        const user = this.UserStore?.getCurrentUser();
        if (!user || !this.real || !this.spoofed.has(user)) return;
        user.premiumType = this.real.premiumType;
        user.perks = this.real.perks;
        this.spoofed.delete(user);
    }

    // --- emotes ---

    hasRealNitro() {
        return this.real?.premiumType > 0; // every tier (Basic/Classic/Nitro) can use emotes everywhere
    }

    canUseNatively(emoji, guildId) {
        const emojiGuild = emoji.guildId ?? emoji.guild_id;
        return !emoji.animated && emojiGuild != null && emojiGuild === guildId && emoji.available !== false;
    }

    emojiUrl(emoji) {
        return `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "webp"}?size=${this.settings.emojiSize}&name=${encodeURIComponent(emoji.name ?? "emoji")}`;
    }

    replaceEmojis(channelId, content, emojis) {
        if (this.hasRealNitro()) return content;
        const guildId = this.ChannelStore?.getChannel(channelId)?.guild_id;
        for (const emoji of emojis) {
            if (!emoji?.id || this.canUseNatively(emoji, guildId)) continue; // unicode or usable emote
            const url = this.emojiUrl(emoji);
            content = content.replace(new RegExp(`<a?:[^:<>\\s]+:${emoji.id}>`, "g"), (match, offset, str) => {
                const before = offset > 0 && !/\s/.test(str[offset - 1]) ? " " : "";
                const after = offset + match.length < str.length && !/\s/.test(str[offset + match.length]) ? " " : "";
                return before + url + after;
            });
        }
        return content;
    }

    // Link fields use our own <input> plus "Paste" / "Clear" buttons. In the settings modal Discord swallows
    // keystrokes (typing and Backspace did nothing, only Ctrl+V worked), so the field edits itself:
    // printable keys, Backspace and Delete are applied by hand with the browser default turned off.
    // State is local, saving is debounced and can't block the field.
    linkInput(id) {
        const React = this.api.React ?? BdApi.React;
        const plugin = this;
        const h = React.createElement;
        const stop = e => e.stopPropagation();
        const buttonStyle = {
            flex: "none", height: 32, padding: "0 12px", border: "none", borderRadius: 4, cursor: "pointer",
            background: "var(--button-secondary-background, #4e5058)", color: "var(--white, #fff)", font: "inherit", fontSize: 14
        };
        const readClipboard = async () => {
            try {
                const text = window.DiscordNative?.clipboard?.read?.();
                if (typeof text === "string") return text;
            } catch {}
            return navigator.clipboard?.readText?.() ?? "";
        };
        // keydown handler that edits the input by hand: edit(next, cursor); Enter → onEnter
        const manualKeys = (edit, onEnter) => e => {
            e.stopPropagation();
            if (e.key === "Enter" && onEnter) return e.preventDefault(), onEnter();
            if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+V/A/C/X work natively
            const el = e.currentTarget;
            const v = el.value, start = el.selectionStart ?? v.length, end = el.selectionEnd ?? start;
            let next, cursor;
            if (e.key === "Backspace") {
                if (start !== end) [next, cursor] = [v.slice(0, start) + v.slice(end), start];
                else if (start > 0) [next, cursor] = [v.slice(0, start - 1) + v.slice(start), start - 1];
                else return e.preventDefault();
            } else if (e.key === "Delete") {
                if (start !== end) [next, cursor] = [v.slice(0, start) + v.slice(end), start];
                else [next, cursor] = [v.slice(0, start) + v.slice(start + 1), start];
            } else if (e.key.length === 1) {
                [next, cursor] = [v.slice(0, start) + e.key + v.slice(end), start + 1];
            } else {
                return; // arrows, Home/End, Tab… stay native
            }
            e.preventDefault();
            edit(next, cursor);
        };
        // Discord's settings swallow keys before React sees them, so the handler is also attached natively on the
        // element itself (the event reaches its target before it bubbles to whatever eats it). React's onKeyDown
        // stays as a fallback; __npHandled keeps one key from being applied twice.
        const useNativeKeys = (ref, handlerRef, deps = []) => React.useEffect(() => {
            const el = ref.current;
            if (!el?.addEventListener) return;
            const onKey = e => {
                plugin.noteKey("target", e);
                if (e.__npHandled) return;
                e.__npHandled = true;
                handlerRef.current?.(e);
            };
            el.addEventListener("keydown", onKey, true);
            return () => el.removeEventListener("keydown", onKey, true);
        }, deps);
        const reactKeys = handlerRef => e => {
            if (e.nativeEvent?.__npHandled || e.__npHandled) return;
            plugin.noteKey("react", e);
            handlerRef.current?.(e);
        };
        const kind = {decorationUrl: "decoration", nameplateUrl: "nameplate", bannerUrl: "gif"}[id];
        const Gallery = this.galleryComponent(React, manualKeys, buttonStyle, useNativeKeys, reactKeys);

        return function NitroPerksLinkInput() {
            const [value, setValue] = React.useState(plugin.settings[id] ?? "");
            const ref = React.useRef(null);
            const caret = React.useRef(null);
            React.useLayoutEffect?.(() => {
                if (caret.current == null || !ref.current) return;
                ref.current.setSelectionRange(caret.current, caret.current);
                caret.current = null;
            });

            const commit = (next, cursor) => {
                setValue(next);
                if (cursor != null) caret.current = cursor;
                clearTimeout(plugin.inputTimers?.[id]);
                plugin.inputTimers = {...plugin.inputTimers, [id]: setTimeout(() => {
                    try {
                        plugin.updateSetting(id, next.trim());
                    } catch (err) {
                        console.error("[NitroPerks] saving", id, "failed", err);
                    }
                }, 400)};
            };

            const keyHandler = React.useRef(null);
            keyHandler.current = manualKeys(commit);
            useNativeKeys(ref, keyHandler);
            const onKeyDown = reactKeys(keyHandler);

            // Try to load the link as an image and say whether it works (the usual mistake is a page link
            // like imgur.com/abc instead of the image itself, i.imgur.com/abc.png).
            const [check, setCheck] = React.useState(null);
            React.useEffect(() => {
                const link = value.trim();
                if (!link) return setCheck(null);
                if (!isValidUrl(link)) return setCheck({tone: "bad", text: plugin.t("notLink")});
                setCheck({tone: "muted", text: plugin.t("checking")});
                let alive = true;
                const img = new Image();
                // Signed Discord attachment links (…?ex=<hex unix time>&is=…&hm=…) die after about a day and are
                // far too long to share through About Me.
                const expires = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\//.test(link) && new URL(link).searchParams.get("ex");
                const expiry = expires ? new Date(parseInt(expires, 16) * 1000).toLocaleString() : null;
                img.onload = () => alive && setCheck(expiry
                    ? {tone: "warn", text: plugin.t("discordLink").replace("{0}", expiry)}
                    : {tone: "ok", text: plugin.t("imageOk").replace("{0}", img.naturalWidth).replace("{1}", img.naturalHeight)});
                img.onerror = () => alive && setCheck({tone: "bad", text: plugin.t("imageBad")});
                // through the same proxy the cosmetics use, so blocked hosts are checked the way they'll be shown
                const timer = setTimeout(() => {
                    plugin.resolveImage(link).then(src => { if (alive) img.src = src; }, () => alive && img.onerror());
                }, 400);
                return () => { alive = false; clearTimeout(timer); };
            }, [value]);
            const toneColor = {ok: "var(--text-positive, #23a55a)", warn: "var(--text-warning, #f0b232)", bad: "var(--text-danger, #f23f43)", muted: "var(--text-muted, #949ba4)"};

            return h("div", {style: {width: "100%"}},
                h("div", {style: {display: "flex", gap: 8, alignItems: "center", width: "100%"}},
                h("input", {
                    ref,
                    type: "text",
                    className: "bd-text-input",
                    "data-nitroperks": "link",
                    style: {flex: 1, minWidth: 0},
                    value,
                    placeholder: "https://i.imgur.com/...",
                    spellCheck: false,
                    onChange: e => commit(e.currentTarget.value),
                    onKeyDown,
                    onKeyUp: stop,
                    onKeyPress: stop,
                    onPaste: stop
                }),
                h("button", {
                    type: "button",
                    style: buttonStyle,
                    onClick: async () => commit(((await readClipboard()) ?? "").trim())
                }, plugin.t("paste")),
                h("button", {
                    type: "button",
                    style: buttonStyle,
                    onClick: () => commit("", 0)
                }, plugin.t("clear"))
                ),
                check && h("div", {style: {marginTop: 6, fontSize: 13, color: toneColor[check.tone]}}, check.text),
                kind && h(Gallery, {kind, selected: value.trim(), onPick: url => commit(url, url.length)})
            );
        };
    }

    // "Choose from catalog": Discord shop frames/nameplates (with a name filter) or GIF search for banners.
    galleryComponent(React, manualKeys, buttonStyle, useNativeKeys, reactKeys) {
        const plugin = this;
        const h = React.createElement;
        const stop = e => e.stopPropagation();
        const MAX_TILES = 240;
        const tileSize = {
            decoration: {gridTemplateColumns: "repeat(auto-fill, minmax(76px, 1fr))", height: 76},
            nameplate: {gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", height: 40},
            gif: {gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", height: 72}
        };

        return function NitroPerksGallery({kind, selected, onPick}) {
            const [open, setOpen] = React.useState(false);
            const [items, setItems] = React.useState(null);
            const [error, setError] = React.useState(null);
            const [text, setText] = React.useState("");
            const [search, setSearch] = React.useState(""); // submitted GIF query
            const isGif = kind === "gif";
            const inputRef = React.useRef(null);
            const keyHandler = React.useRef(null);
            const submit = query => {
                const q = (query ?? text).trim();
                setText(q);
                setSearch(q);
            };
            keyHandler.current = manualKeys(next => setText(next), isGif ? () => submit() : undefined);
            useNativeKeys(inputRef, keyHandler, [open]); // the input only exists while the catalog is open

            React.useEffect(() => {
                if (!open) return;
                let alive = true;
                setItems(null);
                setError(null);
                const load = isGif
                    ? plugin.searchGifs(search)
                    : plugin.shopCatalog().then(c => kind === "decoration" ? c.decorations : c.nameplates);
                load.then(list => alive && setItems(list), e => alive && setError(String(e?.message ?? e)));
                return () => { alive = false; };
            }, [open, kind, isGif ? search : ""]);

            const toggle = h("button", {type: "button", style: {...buttonStyle, marginTop: 8}, onClick: () => setOpen(!open)},
                plugin.t(open ? "catalogClose" : "catalogOpen"));
            if (!open) return toggle;

            const filter = text.trim().toLowerCase();
            const visible = (items ?? []).filter(item => isGif || !filter || item.name.toLowerCase().includes(filter));
            const size = tileSize[kind];
            const tile = item => h("button", {
                type: "button",
                key: item.url,
                title: item.name,
                onClick: () => onPick(item.url),
                style: {
                    height: size.height, padding: 0, cursor: "pointer", borderRadius: 6, overflow: "hidden",
                    border: item.url === selected ? "2px solid var(--brand-500, #5865f2)" : "2px solid transparent",
                    background: kind === "decoration" ? "radial-gradient(circle, var(--background-modifier-accent, #4e505880) 0 34%, transparent 35%)" : "var(--background-secondary, #2b2d31)"
                }
            }, h("img", {src: item.thumb, loading: "lazy", alt: item.name, style: {width: "100%", height: "100%", objectFit: kind === "decoration" ? "contain" : "cover", display: "block"}}));

            const status = error ? plugin.t("catalogFailed").replace("{0}", error)
                : items == null ? plugin.t("catalogLoading")
                : !visible.length ? plugin.t("catalogEmpty")
                : visible.length > MAX_TILES ? plugin.t("catalogMore").replace("{0}", MAX_TILES).replace("{1}", visible.length)
                : "";
            // one-click searches, so a banner can be picked without typing at all
            const chips = isGif && h("div", {style: {display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8}},
                GIF_SUGGESTIONS.map(q => h("button", {
                    type: "button", key: q, onClick: () => submit(q),
                    style: {...buttonStyle, height: 26, padding: "0 10px", fontSize: 13, opacity: q === search ? 1 : 0.8,
                        outline: q === search ? "2px solid var(--brand-500, #5865f2)" : "none"}
                }, q)));

            return h("div", {style: {marginTop: 8}},
                toggle,
                h("div", {style: {marginTop: 8, fontSize: 13, color: "var(--text-muted, #949ba4)"}}, plugin.t(isGif ? "catalogGifSource" : "catalogShopSource")),
                h("div", {style: {display: "flex", gap: 8, marginTop: 8}},
                    h("input", {
                        ref: inputRef,
                        type: "text",
                        className: "bd-text-input",
                        "data-nitroperks": "search",
                        style: {flex: 1, minWidth: 0},
                        value: text,
                        placeholder: plugin.t(isGif ? "catalogSearch" : "catalogFilter"),
                        spellCheck: false,
                        onChange: e => setText(e.currentTarget.value),
                        onKeyDown: reactKeys(keyHandler),
                        onKeyUp: stop,
                        onKeyPress: stop,
                        onPaste: stop
                    }),
                    isGif && h("button", {type: "button", style: buttonStyle, onClick: () => submit()}, plugin.t("catalogFind"))
                ),
                chips,
                status && h("div", {style: {marginTop: 8, fontSize: 13, color: error ? "var(--text-danger, #f23f43)" : "var(--text-muted, #949ba4)"}}, status),
                visible.length > 0 && h("div", {
                    style: {display: "grid", gap: 6, marginTop: 8, maxHeight: 340, overflowY: "auto", paddingRight: 4, gridTemplateColumns: size.gridTemplateColumns}
                }, visible.slice(0, MAX_TILES).map(tile))
            );
        };
    }

    getSettingsPanel() {
        const item = (type, id, extra = {}) => {
            const [name, note] = this.t(id);
            return {type, id, name, note, value: this.settings[id], ...extra};
        };
        const React = this.api.React ?? BdApi.React;
        const link = id => item("custom", id, {inline: false, children: React.createElement(this.linkInput(id))});
        return this.api.UI.buildSettingsPanel({
            settings: [
                item("switch", "spoofNitro"),
                item("switch", "emojiBypass"),
                item("dropdown", "emojiSize", {options: [32, 48, 64, 96, 128].map(n => ({label: `${n}px`, value: n}))}),
                item("dropdown", "streamFps", {options: [{label: this.t("streamFpsDefault"), value: 0}, ...[90, 120, 144, 165, 240].map(n => ({label: `${n} fps`, value: n}))]}),
                item("dropdown", "voiceBitrate", {options: [{label: this.t("voiceBitrateDefault"), value: 0}, ...[96, 128, 192, 256, 384, 510].map(n => ({label: `${n} kbps`, value: n}))]}),
                item("switch", "clientsidePfp"),
                link("pfpUrl"),
                item("switch", "customBanner"),
                link("bannerUrl"),
                item("switch", "customDecoration"),
                link("decorationUrl"),
                item("switch", "customNameplate"),
                link("nameplateUrl"),
                item("switch", "shareAvatar"),
                item("switch", "showShared")
            ],
            onChange: (_, id, value) => {
                try {
                    this.updateSetting(id, value);
                } catch (e) {
                    console.error("[NitroPerks] saving", id, "failed", e);
                }
            }
        });
    }
};
/*@end@*/
