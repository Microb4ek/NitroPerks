# NitroPerks

Unlock all screensharing modes, and use cross-server emotes & gif emotes, Discord wide! A [BetterDiscord](https://betterdiscord.app/) plugin.

Works with the current Discord client and BetterDiscord 1.11+.

**[English](#english)** · **[Русский](#русский)**

[![Download](https://img.shields.io/badge/Download-NitroPerks.plugin.js-5865F2?style=for-the-badge)](https://github.com/Microb4ek/NitroPerks/releases/latest/download/NitroPerks.plugin.js)

---

## English

### Features

| Feature | What it does |
| --- | --- |
| **Spoof Nitro** | Makes the client think you have Nitro: unlocks 1080p / Source @ 60 fps in the screenshare picker and lets you pick any emote in the emoji picker. |
| **Nitro Emotes Bypass** | Emotes you can't really use (from other servers, animated) are sent as image links that Discord shows as pictures. Emotes you can use normally stay untouched. Works when editing messages too. |
| **Emote Size** | Size of the linked emote image: 32 / 48 / 64 / 96 / 128 px. |
| **Custom Avatar** | Replaces your avatar with any image or GIF link. Use the **Paste** / **Clear** buttons next to the field; below it the plugin shows whether the link really loads an image. Use a direct image link (e.g. `i.imgur.com/….gif` or `media1.tenor.com/….gif`) — Discord attachment links expire after about a day. |
| **Custom Profile Banner** | Shows any image or GIF as the background at the top of your profile, like a Nitro banner. Best in 5:2 proportions (e.g. 600×240). |
| **Custom Avatar Frame** | Draws any PNG or GIF with a transparent middle around your avatar everywhere, like Discord's avatar decorations. |
| **Custom Nameplate** | Shows a wide image behind your name in the server member list and DMs, like Discord's nameplates. |
| **Catalog** | No need to hunt for pictures: under the frame and nameplate links, *Choose from catalog* opens Discord's own shop frames and nameplates; under the banner link it opens Discord's GIF search (Tenor) with one-click suggestions. Click a picture to use it. |
| **Shared cosmetics** | Turn on *Show my cosmetics to other NitroPerks users* and everyone with the plugin sees your custom avatar, banner, frame and nameplate — no server needed. The links are stored as an invisible code in your **About Me**; people without the plugin see your normal profile and normal bio. Other users' cosmetics appear once Discord loads their profile (open it or chat in DMs) and are remembered after that. |
| **Stream FPS** *(experimental)* | When you pick 60 fps for a stream, sends 90 / 120 / 144 / 165 / 240 fps to the encoder instead. Restart the stream to apply. Discord's servers may still cap the stream at 60 — check the real FPS on the viewer's side. |
| **Voice Bitrate** *(experimental)* | Sends your microphone at 96–510 kbps instead of the channel's bitrate (64 kbps in DMs and on servers without boosts) — in voice channels, DM calls and for your stream's sound. Applies right away, no reconnect needed. Above ~128 kbps the difference in voice is small. |

If your account already has Nitro, the plugin doesn't change anything (except Stream FPS and Voice Bitrate, which work for everyone).

### Installation

**1. Install BetterDiscord**

1. Download the official installer from [betterdiscord.app](https://betterdiscord.app/) or from [GitHub Releases](https://github.com/BetterDiscord/Installer/releases/latest).
2. Run it, choose **Install**, select your Discord version (Stable / PTB / Canary) and confirm.
3. Discord restarts. A **BetterDiscord** section appears in User Settings.

**2. Install the plugin**

1. Download **[NitroPerks.plugin.js](https://github.com/Microb4ek/NitroPerks/releases/latest/download/NitroPerks.plugin.js)** (or from the [Releases](https://github.com/Microb4ek/NitroPerks/releases) page).
2. Open Discord → **User Settings → BetterDiscord → Plugins → Open Plugins Folder** and put the file there.
   Or copy it manually into the folder:
   - Windows: `%APPDATA%\BetterDiscord\plugins`
   - macOS: `~/Library/Application Support/BetterDiscord/plugins`
   - Linux: `~/.config/BetterDiscord/plugins`
3. Turn **NitroPerks** on in the plugin list.
4. Press the gear icon next to the plugin to change settings.

> Tip (Windows): if you double-click `NitroPerks.plugin.js`, it offers to copy itself into the BetterDiscord plugins folder.

### Updating

Download the new [NitroPerks.plugin.js](https://github.com/Microb4ek/NitroPerks/releases/latest/download/NitroPerks.plugin.js) and replace the old file in the plugins folder. BetterDiscord reloads it automatically.

### Troubleshooting

- **BetterDiscord disappeared after a Discord update** — run the BetterDiscord installer again.
- **`A fatal Javascript error occured: Cannot find module ...betterdiscord.asar`** — BetterDiscord was injected the old way (a `require` line in `discord_desktop_core\index.js`). Remove that line and install BetterDiscord with the official installer.
- **Toast "NitroPerks: Discord modules not found"** — Discord changed its internals. Open an [issue](https://github.com/Microb4ek/NitroPerks/issues) and paste the text of the toast.

### Limitations

- Spoofing only changes what **your client** thinks. Limits enforced by Discord's servers still apply: large uploads and messages over 2000 characters will be rejected.
- Using client mods is against the [Discord Terms of Service](https://discord.com/terms). Use at your own risk.

### Uninstall

Delete `NitroPerks.plugin.js` from the plugins folder. To remove BetterDiscord, run its installer and choose **Uninstall**.

---

## Русский

### Возможности

| Функция | Что делает |
| --- | --- |
| **Spoof Nitro** | Клиент считает, что у вас есть Nitro: в окне стрима открываются 1080p / Source и 60 fps, в панели эмодзи можно выбрать любой эмодзи. |
| **Nitro Emotes Bypass** | Эмодзи, которые вам на самом деле недоступны (с других серверов, анимированные), отправляются ссылками на картинку, и Discord показывает их как изображения. Доступные эмодзи отправляются как обычно. Работает и при редактировании сообщений. |
| **Emote Size** | Размер картинки эмодзи: 32 / 48 / 64 / 96 / 128 px. |
| **Своя аватарка** | Заменяет вашу аватарку на любую картинку или GIF по ссылке. Рядом с полем есть кнопки **«Вставить»** и **«Очистить»**, а под полем плагин показывает, грузится ли картинка. Нужна прямая ссылка на картинку (например, `i.imgur.com/….gif` или `media1.tenor.com/….gif`): ссылки на вложения Discord перестают работать примерно через сутки. |
| **Свой баннер профиля** | Показывает любую картинку или GIF фоном в шапке профиля, как баннер Nitro. Лучше в пропорциях 5:2 (например, 600×240). |
| **Своя рамка аватарки** | Рисует любой PNG или GIF с прозрачной серединой вокруг вашей аватарки везде, как украшения аватара в Discord. |
| **Своя подложка ника** | Показывает широкую картинку за вашим ником в списке участников сервера и в ЛС, как таблички с именем в Discord. |
| **Каталог** | Картинки не нужно искать: под ссылками на рамку и подложку кнопка *«Выбрать из каталога»* открывает официальные рамки и подложки из магазина Discord, а под ссылкой на баннер — поиск GIF Discord (Tenor) с готовыми подсказками. Нажмите на картинку, чтобы поставить её. |
| **Общая косметика** | Включите *Показывать мою косметику пользователям NitroPerks*, и вашу аватарку, баннер, рамку и подложку увидят все, у кого стоит плагин, без всякого сервера. Ссылки хранятся невидимым кодом в **«Обо мне»**: без плагина виден обычный профиль и обычное описание. Косметика других людей появляется, когда Discord один раз загрузит их профиль (откройте его или напишите в ЛС), и дальше запоминается. |
| **Stream FPS** *(экспериментально)* | Когда вы выбираете для стрима 60 fps, кодировщик вместо этого получает 90 / 120 / 144 / 165 / 240 fps. Чтобы применить, перезапустите стрим. Серверы Discord могут всё равно ограничить стрим до 60 — проверяйте реальную частоту кадров у зрителя. |
| **Битрейт голоса** *(экспериментально)* | Микрофон отправляется с битрейтом 96–510 кбит/с вместо битрейта канала (64 кбит/с в ЛС и на серверах без бустов) — в голосовых каналах, личных звонках и для звука вашего стрима. Применяется сразу, переподключаться не нужно. Выше ~128 кбит/с разница в голосе уже небольшая. |

Если у аккаунта уже есть Nitro, плагин ничего не меняет (кроме Stream FPS и битрейта голоса — эти функции работают у всех).

### Установка

**1. Установите BetterDiscord**

1. Скачайте официальный установщик с [betterdiscord.app](https://betterdiscord.app/) или со страницы [GitHub Releases](https://github.com/BetterDiscord/Installer/releases/latest).
2. Запустите его, выберите **Install**, отметьте свою версию Discord (Stable / PTB / Canary) и подтвердите.
3. Discord перезапустится, в настройках пользователя появится раздел **BetterDiscord**.

**2. Установите плагин**

1. Скачайте **[NitroPerks.plugin.js](https://github.com/Microb4ek/NitroPerks/releases/latest/download/NitroPerks.plugin.js)** (или со страницы [Releases](https://github.com/Microb4ek/NitroPerks/releases)).
2. Откройте Discord → **Настройки пользователя → BetterDiscord → Plugins → Open Plugins Folder** и положите туда файл.
   Или скопируйте его в папку вручную:
   - Windows: `%APPDATA%\BetterDiscord\plugins`
   - macOS: `~/Library/Application Support/BetterDiscord/plugins`
   - Linux: `~/.config/BetterDiscord/plugins`
3. Включите **NitroPerks** в списке плагинов.
4. Настройки плагина открываются по значку шестерёнки рядом с ним.

> Подсказка (Windows): если дважды щёлкнуть по `NitroPerks.plugin.js`, он предложит сам скопироваться в папку плагинов BetterDiscord.

### Обновление

Скачайте новый [NitroPerks.plugin.js](https://github.com/Microb4ek/NitroPerks/releases/latest/download/NitroPerks.plugin.js) и замените старый файл в папке плагинов. BetterDiscord перезагрузит его сам.

### Если что-то не работает

- **BetterDiscord пропал после обновления Discord** — запустите установщик BetterDiscord ещё раз.
- **`A fatal Javascript error occured: Cannot find module ...betterdiscord.asar`** — BetterDiscord внедрён старым способом (строка `require` в `discord_desktop_core\index.js`). Удалите эту строку и установите BetterDiscord официальным установщиком.
- **Уведомление «NitroPerks: Discord modules not found»** — Discord поменял внутреннее устройство. Создайте [issue](https://github.com/Microb4ek/NitroPerks/issues) и вставьте текст уведомления.

### Ограничения

- Подмена Nitro меняет только то, что думает **ваш клиент**. Ограничения на стороне серверов Discord остаются: большие файлы и сообщения длиннее 2000 символов сервер отклонит.
- Клиентские моды нарушают [Условия использования Discord](https://discord.com/terms). Используйте на свой страх и риск.

### Удаление

Удалите `NitroPerks.plugin.js` из папки плагинов. Чтобы удалить BetterDiscord, запустите его установщик и выберите **Uninstall**.

---

[MIT License](LICENSE)
