/**
 * @name NitroPerks
 * @author Microb4ek, lemons
 * @authorLink https://github.com/Microb4ek
 * @version 2.2.0
 * @description Unlock all screensharing modes, use cross-server emotes & gif emotes Discord wide, and share a custom avatar and profile banner with other NitroPerks users! (You CANNOT upload 100MB files though. :/)
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
//  * Shared avatars/banners, no server: the links are appended to "About Me" as invisible Unicode tag characters
//    (U+E0020–E007E, one per ASCII char): "np:a<link> b<link>". Only the profile owner can edit the bio, so
//    nobody can set them for someone else. Discord loads bios lazily (profile popout, DM sidebar), so we
//    read them from USER_PROFILE_FETCH_SUCCESS and keep what we learn in a local cache.
//  * Experimental stream FPS: Discord's picker stops at 60, but the native connection's setGoLiveSource
//    passes quality.frameRate straight to the encoder (setDesktopEncodingOptions) and to the stream's
//    maxFrameRate, so we swap 60 for the chosen value there. The media server may still cap it.

const PREMIUM_TIER_2 = 2;
const PICKER_MAX_FPS = 60;

const DEFAULT_SETTINGS = {
    spoofNitro: true,
    emojiBypass: true,
    emojiSize: 48,
    clientsidePfp: false,
    pfpUrl: "",
    customBanner: false,
    bannerUrl: "",
    shareAvatar: false,
    showShared: true,
    streamFps: 0 // 0 = leave Discord's value
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
// Short host codes keep the hidden text small (the bio limit counts it too). Order matters: specific first.
const HOSTS = [
    ["i/", "https://i.imgur.com/"],
    ["d/", "https://cdn.discordapp.com/"],
    ["m/", "https://media.discordapp.net/"],
    ["t/", "https://media.tenor.com/"],
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

// {avatar, banner} -> invisible text ("" when there's nothing to share)
const encodeProfile = ({avatar, banner}) => {
    const parts = [avatar && "a" + packLink(avatar), banner && "b" + packLink(banner)].filter(Boolean);
    if (!parts.length) return "";
    return [...CODE_PREFIX + parts.join(" ")].map(c => String.fromCodePoint(TAG_BASE + c.charCodeAt(0))).join("");
};

const decodeRun = run => [...run].map(c => String.fromCharCode(c.codePointAt(0) - TAG_BASE)).join("");

// bio -> {avatar, banner} (nulls when absent)
const decodeProfile = bio => {
    const found = {avatar: null, banner: null};
    for (const [run] of (bio ?? "").matchAll(TAG_RUN)) {
        const text = decodeRun(run);
        if (!text.startsWith(CODE_PREFIX)) continue;
        for (const part of text.slice(CODE_PREFIX.length).split(" ")) {
            if (part[1] === "/") found.avatar = unpackLink(part); // 2.2.0 format: just the avatar link
            else if (part[0] === "a") found.avatar = unpackLink(part.slice(1));
            else if (part[0] === "b") found.banner = unpackLink(part.slice(1));
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
        clientsidePfp: ["Custom Avatar", "Replaces your avatar with the image below."],
        pfpUrl: ["Avatar Link", "Direct http(s) link to an image or GIF, e.g. https://i.imgur.com/abc.gif. Short links leave more room in your About Me."],
        customBanner: ["Custom Profile Banner", "Shows the image below as the background at the top of your profile."],
        bannerUrl: ["Banner Link", "Direct http(s) link to an image or GIF, best in 5:2 proportions (e.g. 600×240)."],
        shareAvatar: ["Show my avatar and banner to other NitroPerks users", "Adds an invisible code to your About Me. Other NitroPerks users see your custom avatar and banner, everyone else sees your normal profile."],
        showShared: ["Show avatars and banners of other NitroPerks users", "They appear after Discord loads the person's profile once (open it or chat in DMs), then they are remembered."],
        publishing: "Saving to About Me…",
        published: "Done! Other NitroPerks users will see your profile.",
        unpublished: "Removed the code from your About Me.",
        needLink: "Turn on Custom Avatar or Custom Profile Banner and paste a valid link first.",
        noProfile: "Couldn't load your profile, nothing was changed. Try again in a minute.",
        stripped: "Discord removed the hidden code from your About Me, sharing doesn't work right now.",
        saveFailed: "Couldn't save About Me: ",
        tooLong: "About Me is too long for the code. Shorten it or use a shorter link (e.g. i.imgur.com).",
        missing: "NitroPerks: Discord modules not found ({0}), some features are off.",
        noEngine: "NitroPerks: media engine not found, custom stream FPS is off."
    },
    ru: {
        spoofNitro: ["Подмена Nitro", "Открывает стрим 1080p/исходное качество и 60 fps, а также выбор любых эмодзи. Нужна для обхода эмодзи."],
        emojiBypass: ["Обход эмодзи Nitro", "Недоступные вам эмодзи отправляются ссылками на картинку."],
        emojiSize: ["Размер эмодзи", "Размер картинки эмодзи в сообщении."],
        streamFps: ["Частота кадров стрима (эксперимент)", "Заменяет 60 fps, когда вы выбираете 60 в настройках стрима. Чтобы применить, перезапустите стрим. Серверы Discord могут всё равно ограничить до 60."],
        streamFpsDefault: "Как в Discord",
        clientsidePfp: ["Своя аватарка", "Заменяет вашу аватарку на картинку по ссылке ниже."],
        pfpUrl: ["Ссылка на аватарку", "Прямая ссылка на картинку или GIF, например https://i.imgur.com/abc.gif. Чем короче ссылка, тем больше места останется в «Обо мне»."],
        customBanner: ["Свой баннер профиля", "Показывает картинку по ссылке ниже фоном в шапке вашего профиля."],
        bannerUrl: ["Ссылка на баннер", "Прямая ссылка на картинку или GIF, лучше в пропорциях 5:2 (например, 600×240)."],
        shareAvatar: ["Показывать мою аватарку и баннер пользователям NitroPerks", "Добавляет невидимый код в «Обо мне». Пользователи NitroPerks увидят вашу аватарку и баннер, остальные — обычный профиль."],
        showShared: ["Показывать аватарки и баннеры других пользователей NitroPerks", "Они появятся, когда Discord один раз загрузит профиль человека (откройте его или напишите в ЛС), дальше запоминаются."],
        publishing: "Сохраняю в «Обо мне»…",
        published: "Готово! Пользователи NitroPerks увидят ваш профиль.",
        unpublished: "Код убран из «Обо мне».",
        needLink: "Сначала включите «Своя аватарка» или «Свой баннер профиля» и вставьте рабочую ссылку.",
        noProfile: "Не удалось загрузить ваш профиль, ничего не изменено. Попробуйте через минуту.",
        stripped: "Discord удалил скрытый код из «Обо мне», делиться аватаркой сейчас не получится.",
        saveFailed: "Не удалось сохранить «Обо мне»: ",
        tooLong: "В «Обо мне» не хватает места для кода. Сократите текст или возьмите ссылку покороче (например, i.imgur.com).",
        missing: "NitroPerks: не найдены модули Discord ({0}), часть функций отключена.",
        noEngine: "NitroPerks: не найден медиадвижок, своя частота кадров стрима отключена."
    }
};

module.exports = class NitroPerks {
    constructor(meta) {
        this.meta = meta;
        this.api = new BdApi(meta.name);
        this.spoofed = new WeakSet();
        this.real = null; // {premiumType, perks} of the account before spoofing
        this.onProfileFetched = this.onProfileFetched.bind(this);
        this.onProfileUpdated = this.onProfileUpdated.bind(this);
    }

    start() {
        this.settings = {...DEFAULT_SETTINGS, ...this.api.Data.load("settings")};
        this.shared = this.api.Data.load("sharedProfiles") ?? {}; // userId -> {avatar, banner, seen}

        const {Webpack} = this.api;
        const filter = Webpack.Filters.byKeys ?? Webpack.Filters.byProps;
        const byKeys = (...keys) => Webpack.getModule(filter(...keys), {searchExports: true});
        const byStrings = (...strings) => Webpack.Filters.byStrings && Webpack.getModule(Webpack.Filters.byStrings(...strings), {searchExports: true});
        this.UserStore = Webpack.getStore("UserStore");
        this.ChannelStore = Webpack.getStore("ChannelStore");
        this.EmojiStore = Webpack.getStore("EmojiStore");
        this.UserProfileStore = Webpack.getStore("UserProfileStore");
        this.LocaleStore = Webpack.getStore("LocaleStore");
        this.MediaEngineStore = Webpack.getStore("MediaEngineStore");
        this.MessageActions = byKeys("_sendMessage", "editMessage", "sendMessage");
        this.AvatarUtils = byKeys("getUserAvatarURL", "getGuildMemberAvatarURLSimple");
        this.Dispatcher = byKeys("dispatch", "subscribe", "unsubscribe", "isDispatching");
        this.fetchProfile = byStrings("USER_PROFILE_FETCH_START", "USER_PROFILE_FETCH_SUCCESS");
        this.saveProfile = byStrings("USER_PROFILE_UPDATE_START", "USER_PROFILE_UPDATE_SUCCESS");
        this.getDisplayProfile = byStrings(".getUserProfile(", ".getGuildMemberProfile(", "arguments[2]");

        const missing = ["UserStore", "ChannelStore", "MessageActions", "AvatarUtils"].filter(name => !this[name]);
        if (missing.length) this.toast(this.t("missing").replace("{0}", missing.join(", ")), "error");

        this.Dispatcher?.subscribe("USER_PROFILE_FETCH_SUCCESS", this.onProfileFetched);
        this.Dispatcher?.subscribe("USER_PROFILE_UPDATE_SUCCESS", this.onProfileUpdated);
        this.applyPatches();
    }

    stop() {
        this.Dispatcher?.unsubscribe("USER_PROFILE_FETCH_SUCCESS", this.onProfileFetched);
        this.Dispatcher?.unsubscribe("USER_PROFILE_UPDATE_SUCCESS", this.onProfileUpdated);
        clearTimeout(this.shareTimer);
        clearTimeout(this.cacheTimer);
        this.api.Patcher.unpatchAll();
        this.restoreUser();
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
        this.api.Patcher.unpatchAll();
        this.restoreUser();
        this.applyPatches();
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

        if (this.settings.streamFps > 0) {
            // The connection class isn't exported: patch its prototype through the engine instead,
            // on connections that already exist and on every new one from engine.connect().
            const engine = this.MediaEngineStore?.getMediaEngine?.();
            if (engine?.connect) {
                this.patchedConnections = new WeakSet();
                engine.eachConnection?.(conn => this.patchConnection(conn));
                Patcher.after(engine, "connect", (_, __, conn) => this.patchConnection(conn));
            } else {
                this.toast(this.t("noEngine"), "error");
            }
        }

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
                    return url ? wrap(url) : ret;
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
                }
                return proxy;
            });
            const proto = this.displayProfilePrototype();
            if (proto?.getBannerURL) {
                Patcher.after(proto, "getBannerURL", (profile, _, ret) => this.bannerFor(profile?.userId) ?? ret);
            }
        }
    }

    // DisplayProfile isn't exported; getDisplayProfile(userId, guildId, [UserStore, UserProfileStore]) is.
    displayProfilePrototype() {
        try {
            const sample = this.getDisplayProfile?.("0", null, [
                {getUser: () => ({})},
                {getUserProfile: () => ({}), getGuildMemberProfile: () => null}
            ]);
            return sample && Object.getPrototypeOf(sample);
        } catch (e) {
            console.error("[NitroPerks] DisplayProfile not found", e);
            return null;
        }
    }

    // --- avatars & banners ---

    ownAvatar() {
        return this.settings.clientsidePfp && isValidUrl(this.settings.pfpUrl) ? this.settings.pfpUrl : null;
    }

    ownBanner() {
        return this.settings.customBanner && isValidUrl(this.settings.bannerUrl) ? this.settings.bannerUrl : null;
    }

    isMe(userId) {
        return userId != null && userId === this.UserStore?.getCurrentUser()?.id;
    }

    avatarFor(userId) {
        if (userId == null) return null;
        if (this.isMe(userId)) return this.ownAvatar();
        return this.settings.showShared ? this.shared[userId]?.avatar ?? null : null;
    }

    bannerFor(userId) {
        if (userId == null) return null;
        if (this.isMe(userId)) return this.ownBanner();
        return this.settings.showShared ? this.shared[userId]?.banner ?? null : null;
    }

    onProfileFetched({userProfile}) {
        const userId = userProfile?.user?.id;
        if (userId) this.learn(userId, userProfile.user_profile?.bio);
    }

    onProfileUpdated({userId, guildId, bio}) {
        if (userId && guildId == null && typeof bio === "string") this.learn(userId, bio);
    }

    learn(userId, bio) {
        const {avatar, banner} = decodeProfile(bio);
        const known = this.shared[userId];
        if ((known?.avatar ?? null) === avatar && (known?.banner ?? null) === banner) return;
        if (avatar || banner) this.shared[userId] = {avatar, banner, seen: Date.now()};
        else delete this.shared[userId];
        clearTimeout(this.cacheTimer);
        this.cacheTimer = setTimeout(() => this.api.Data.save("sharedProfiles", this.shared), 2000);
        for (const store of [this.UserStore, this.UserProfileStore]) {
            try {
                store?.emitChange?.(); // re-render avatars/profiles already on screen
            } catch {}
        }
    }

    // Writes (or removes) the hidden profile code in the current user's About Me.
    // trigger = the setting that changed.
    async syncShare(trigger) {
        const {shareAvatar, clientsidePfp, pfpUrl, customBanner, bannerUrl} = this.settings;
        if (shareAvatar && !this.ownAvatar() && !this.ownBanner() && trigger === "shareAvatar") return this.toast(this.t("needLink"), "warning");
        // the edited link is still being typed: keep what's published until it becomes valid
        if (trigger === "pfpUrl" && clientsidePfp && !isValidUrl(pfpUrl)) return;
        if (trigger === "bannerUrl" && customBanner && !isValidUrl(bannerUrl)) return;
        const want = {avatar: shareAvatar ? this.ownAvatar() : null, banner: shareAvatar ? this.ownBanner() : null};
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

        const same = (a, b) => a.avatar === b.avatar && a.banner === b.banner;
        if (same(decodeProfile(profile.bio), want)) return;
        const sharing = want.avatar || want.banner;
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

    patchConnection(conn) {
        const proto = conn && Object.getPrototypeOf(conn);
        if (!proto || typeof proto.setGoLiveSource !== "function" || this.patchedConnections.has(proto)) return;
        this.patchedConnections.add(proto);
        // setGoLiveSource({desktopDescription | cameraDescription, quality: {resolution, frameRate}})
        this.api.Patcher.before(proto, "setGoLiveSource", (_, args) => {
            const quality = args[0]?.quality;
            if (quality?.frameRate !== PICKER_MAX_FPS) return; // only when 60 was picked
            args[0] = {...args[0], quality: {...quality, frameRate: this.settings.streamFps}};
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

    getSettingsPanel() {
        const item = (type, id, extra = {}) => {
            const [name, note] = this.t(id);
            return {type, id, name, note, value: this.settings[id], ...extra};
        };
        return this.api.UI.buildSettingsPanel({
            settings: [
                item("switch", "spoofNitro"),
                item("switch", "emojiBypass"),
                item("dropdown", "emojiSize", {options: [32, 48, 64, 96, 128].map(n => ({label: `${n}px`, value: n}))}),
                item("dropdown", "streamFps", {options: [{label: this.t("streamFpsDefault"), value: 0}, ...[90, 120, 144, 165, 240].map(n => ({label: `${n} fps`, value: n}))]}),
                item("switch", "clientsidePfp"),
                item("text", "pfpUrl", {placeholder: "https://i.imgur.com/..."}),
                item("switch", "customBanner"),
                item("text", "bannerUrl", {placeholder: "https://i.imgur.com/..."}),
                item("switch", "shareAvatar"),
                item("switch", "showShared")
            ],
            onChange: (_, id, value) => {
                this.settings[id] = value;
                this.saveSettings();
                // Keep About Me in sync with what the user sees: sharing on/off, avatar/banner on/off or a new link.
                const profileFields = ["clientsidePfp", "pfpUrl", "customBanner", "bannerUrl"];
                if (id === "shareAvatar" || (this.settings.shareAvatar && profileFields.includes(id))) {
                    this.scheduleShareSync(id);
                }
            }
        });
    }
};
/*@end@*/
