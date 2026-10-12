/**
 * @name NitroPerks
 * @author Microb4ek, lemons
 * @authorLink https://github.com/Microb4ek
 * @version 2.1.0
 * @description Unlock all screensharing modes, and use cross-server emotes & gif emotes, Discord wide! (You CANNOT upload 100MB files though. :/)
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
//  * The clientside avatar hooks the avatar URL helpers instead of rewriting <img src> in a 100ms loop.
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
    streamFps: 0 // 0 = leave Discord's value
};

const isValidUrl = value => {
    try {
        return /^https?:$/.test(new URL(value).protocol);
    } catch {
        return false;
    }
};

module.exports = class NitroPerks {
    constructor(meta) {
        this.meta = meta;
        this.api = new BdApi(meta.name);
        this.spoofed = new WeakSet();
        this.real = null; // {premiumType, perks} of the account before spoofing
    }

    start() {
        this.settings = {...DEFAULT_SETTINGS, ...this.api.Data.load("settings")};

        const {Webpack} = this.api;
        const filter = Webpack.Filters.byKeys ?? Webpack.Filters.byProps;
        const byKeys = (...keys) => Webpack.getModule(filter(...keys), {searchExports: true});
        this.UserStore = Webpack.getStore("UserStore");
        this.ChannelStore = Webpack.getStore("ChannelStore");
        this.EmojiStore = Webpack.getStore("EmojiStore");
        this.MessageActions = byKeys("_sendMessage", "editMessage", "sendMessage");
        this.AvatarUtils = byKeys("getUserAvatarURL", "getGuildMemberAvatarURLSimple");
        this.MediaEngineStore = Webpack.getStore("MediaEngineStore");

        const missing = ["UserStore", "ChannelStore", "MessageActions", "AvatarUtils"].filter(name => !this[name]);
        if (missing.length) {
            this.api.UI.showToast(`NitroPerks: Discord modules not found (${missing.join(", ")}), some features are off.`, {type: "error"});
        }

        this.applyPatches();
    }

    stop() {
        this.api.Patcher.unpatchAll();
        this.restoreUser();
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
                this.api.UI.showToast("NitroPerks: media engine not found, custom stream FPS is off.", {type: "error"});
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

        if (this.settings.clientsidePfp && isValidUrl(this.settings.pfpUrl) && this.AvatarUtils) {
            const isMe = id => id != null && id === this.UserStore?.getCurrentUser()?.id;
            const url = this.settings.pfpUrl;
            const patch = (method, getId, wrap = u => u) => {
                if (typeof this.AvatarUtils[method] !== "function") return;
                Patcher.after(this.AvatarUtils, method, (_, args, ret) => isMe(getId(args[0])) ? wrap(url) : ret);
            };
            patch("getUserAvatarURL", user => user?.id);
            patch("getUserAvatarSource", user => user?.id, u => ({uri: u}));
            patch("getGuildMemberAvatarURLSimple", opts => opts?.userId);
            patch("getGuildMemberAvatarURL", member => member?.userId);
            patch("getGuildMemberAvatarSource", member => member?.userId, u => ({uri: u}));
        }
    }

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
        return this.api.UI.buildSettingsPanel({
            settings: [
                {type: "switch", id: "spoofNitro", name: "Spoof Nitro", note: "Unlocks 1080p/source @ 60fps screensharing and the emoji picker. Needed for the emote bypass.", value: this.settings.spoofNitro},
                {type: "switch", id: "emojiBypass", name: "Nitro Emotes Bypass", note: "Sends emotes you can't use as image links.", value: this.settings.emojiBypass},
                {type: "dropdown", id: "emojiSize", name: "Emote Size", note: "Size of the linked emote image.", value: this.settings.emojiSize,
                    options: [32, 48, 64, 96, 128].map(n => ({label: `${n}px`, value: n}))},
                {type: "dropdown", id: "streamFps", name: "Stream FPS (experimental)", note: "Replaces 60 fps when you pick 60 in the stream settings. Restart the stream to apply. Discord's servers may still cap it at 60.", value: this.settings.streamFps,
                    options: [{label: "Discord default", value: 0}, ...[90, 120, 144, 165, 240].map(n => ({label: `${n} fps`, value: n}))]},
                {type: "switch", id: "clientsidePfp", name: "Clientsided Profile Picture", note: "Only you see it.", value: this.settings.clientsidePfp},
                {type: "text", id: "pfpUrl", name: "Profile Picture URL", note: "Direct http(s) link to an image. Applied once the link is valid.", value: this.settings.pfpUrl, placeholder: "https://..."}
            ],
            onChange: (_, id, value) => {
                this.settings[id] = value;
                this.saveSettings();
            }
        });
    }
};
/*@end@*/
