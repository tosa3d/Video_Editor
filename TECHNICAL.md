# مستند فنی «بُرش»

آخرین به‌روزرسانی: ۱۸ مهر ۱۴۰۵ (10 Oct 2026). راهنمای کاربر در `README.md` است. این فایل برای کسی است که کد را نگه می‌دارد یا تغییر می‌دهد.

## نمای کلی

یک برنامه‌ی رومیزی ویندوز که یک ویدیو را روی فریم‌های انتخاب‌شده به کلیپ‌های MP4 جداگانه تقسیم می‌کند، و برای کلیپ‌های انتخاب‌شده نسخه‌ی برعکس هم می‌سازد. همه‌چیز آفلاین است و FFmpeg داخل برنامه است.

| لایه | فناوری | فایل |
|---|---|---|
| پوسته‌ی رومیزی | Electron 44 | `electron/main.ts` |
| پل امن بین دو لایه | contextBridge | `electron/preload.cts` |
| رابط کاربری | React 19 + TypeScript، ساخته‌شده با Vite 8 | `src/App.tsx`، `src/App.css`، `src/index.css` |
| انواع مشترک | فایل `.d.ts` سراسری | `src/types/electron.d.ts` |
| پردازش ویدیو | FFmpeg از پکیج `ffmpeg-static` | از `electron/main.ts` اجرا می‌شود |
| بسته‌بندی | electron-builder، نصب‌کننده‌ی NSIS | بخش `build` در `package.json` |

## ساختار

```
electron/main.ts         پروسه‌ی اصلی: پنجره، پروتکل media:، IPC، FFmpeg
electron/preload.cts     API محدود window.videoEditor برای رابط کاربری
src/App.tsx              کل رابط کاربری: پخش، حرکت فریم، برش‌ها، فهرست کلیپ‌ها، خروجی
src/App.css, index.css   ظاهر (پالت زغالی، فیروزه‌ای و نارنجی؛ راست‌به‌چپ)
src/types/electron.d.ts  VideoSelection، ExportRequest، ExportProgress، ExportResult
dist/                    خروجی Vite (در گیت نیست)
dist-electron/           خروجی tsc پروسه‌ی اصلی (در گیت نیست)
release/                 خروجی electron-builder: win-unpacked و Boresh-Setup-x.y.z.exe (در گیت نیست)
```

## امنیت پنجره

- `contextIsolation: true`، `sandbox: true`، `nodeIntegration: false`. رابط کاربری به Node دسترسی ندارد.
- فقط سه تابع از `preload.cts` در دسترس است: `selectVideo`، `exportSegments` و `onExportProgress`.
- باز کردن پنجره‌ی جدید ممنوع است (`setWindowOpenHandler` → deny).
- مسیر فایل ویدیو هیچ‌وقت به رابط کاربری داده نمی‌شود. پروسه‌ی اصلی آن را در `selectedVideoPath` نگه می‌دارد و رابط کاربری فقط آدرس `media://video/current?version=…` را می‌بیند.

## جریان داده

```
کاربر «انتخاب ویدیو»
  → ipc video:select → دیالوگ فایل → selectedVideoPath
  → detectFrameRate (FFmpeg -i، خواندن «NN fps» از stderr)
  → { name, url: media://video/current?version=<زمان>, fps }
<video src=media://…>  → protocol.handle('media') → serveVideo (پاسخ Range با کد 206)
کاربر «خروجی»
  → ipc video:export { cutTimes, duration, fps, reverseStarts }
  → دیالوگ پوشه → برای هر بخش: encodeSegment، و اگر انتخاب شده encodeReversed
  → رویداد video:export-progress در طول کار
  → { canceled, count, reversedCount, directory }
```

## پروتکل `media:` و جلو و عقب رفتن

Chromium فقط وقتی `<video>` را seekable می‌داند که منبع به درخواست‌های `Range` با `206 Partial Content` جواب بدهد. `net.fetch` روی آدرس `file:` هدر Range را نادیده می‌گیرد و `200` برمی‌گرداند. در آن حالت هر seek (خط زمان، حرکت فریم، کلیک روی کلیپ) به ثانیه‌ی ۰ برمی‌گشت.

`serveVideo` در `main.ts` خودش جواب می‌دهد:
- بدون Range: `200` با `Content-Length` و `Accept-Ranges: bytes`.
- `bytes=a-b`، `bytes=a-` و `bytes=-n`: `206` با `Content-Range`، و فقط همان تکه از `createReadStream`.
- بازه‌ی نامعتبر: `416`.
- `Content-Type` از روی پسوند فایل تعیین می‌شود.

## ریاضی فریم‌ها (`src/App.tsx`)

زمان‌های رسانه در Chromium تا میکروثانیه بریده می‌شوند. مثلاً شروع فریم ۱۱ در ۳۰ FPS برابر 0.3666667 است، ولی `currentTime` آن را 0.366666 برمی‌گرداند که قبل از شروع فریم است. سه تابع این را مهار می‌کنند:

| تابع | کار |
|---|---|
| `frameAt(t, fps)` | شماره‌ی فریم روی صفحه: `floor(t × fps + 0.001)`. تلورانس کوچک، شروع خود فریم را به فریم قبلی نسبت نمی‌دهد. |
| `frameSeekTime(n, fps)` | جای seek برای نشان دادن فریم n: `(n + 0.25) / fps`، یعنی یک‌چهارم فریم بعد از شروعش. |
| `formatTimecode` | تایم‌کد `HH:MM:SS:FF` با همان `frameAt`. |

- **حرکت فریم (`stepFrame`):** مکث، بعد seek مستقیم به `frameSeekTime(frameAt(currentTime) ± 1)`. چون `currentTime` بلافاصله مقصد seek در حال اجرا را برمی‌گرداند، نگه داشتن کلید هم فریم‌به‌فریم جلو می‌رود. (نسخه‌ی قبلی ویدیو را کوتاه پخش می‌کرد و منتظر فریم بعد می‌ماند. این روش گاهی ده‌ها فریم جلو می‌پرید.)
- **خط زمان:** مقدار اسلایدر به نزدیک‌ترین فریم گرد می‌شود و با `frameSeekTime` seek می‌شود.
- **برش (`addCut`):** دقیقاً روی شروع فریم روی صفحه ثبت می‌شود (`frameAt(...) / fps`)، پس همان فریم اولین فریم کلیپ بعدی است.
- **میانبرها:** روی `window` گوش داده می‌شوند. فقط در فیلدهای تایپی (کادر FPS) کنار می‌روند، نه وقتی فوکوس روی اسلایدر خط زمان یا تیک‌های «برعکس» است.

## خروجی (`electron/main.ts`)

### `buildSegments`
برش‌های نامعتبر، و برش‌هایی که کمتر از `max(1/fps, 0.04)` ثانیه با برش قبلی یا انتهای ویدیو فاصله دارند، کنار گذاشته می‌شوند. بخش‌ها `[0, c1)`، `[c1, c2)` و … `[cn, duration)` هستند.

### `encodeSegment`
```
ffmpeg -ss <start − 0.25/fps> -i <input> -t <end − start> -map 0:v:0 -map 0:a?
       -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k
       -movflags +faststart -avoid_negative_ts make_zero <out>
```
FFmpeg هر فریمی را که قبل از `-ss` باشد دور می‌ریزد. نوشتن زمان شروع با شش رقم اعشار (11/30 → 0.366667) آن را از زمان خود فریم برش رد می‌کند و آن فریم حذف می‌شد. شروع از یک‌چهارم فریم زودتر، فریم برش را نگه می‌دارد. `-t` تغییر نمی‌کند، پس فریم برش بعدی بیرون از کلیپ می‌ماند. نتیجه‌ی تست: کلیپ‌ها پشت سر هم دقیقاً همه‌ی فریم‌ها را پوشش می‌دهند، بدون فریم تکراری یا جاافتاده.

### `encodeReversed`
روی کلیپِ تازه‌ساخته‌شده اجرا می‌شود:
```
ffmpeg -i <part.mp4> -map 0:v:0 -map 0:a?
       -vf reverse,setpts=N/FRAME_RATE/TB -af areverse,asetpts=N/SR/TB -fps_mode passthrough
       (همان تنظیمات H.264/AAC) <part_reverse.mp4>
```
- زمان‌های کلیپ خروجی از صفر شروع نمی‌شوند. بدون `setpts` و `-fps_mode passthrough`، FFmpeg برای ثابت نگه داشتن نرخ فریم، فریم تکرار یا حذف می‌کرد (یک فریم اضافه، و بعضی فریم‌ها دوبار).
- فیلتر `reverse` کل کلیپ را در رم نگه می‌دارد. برای کلیپ‌های کوتاه تور مناسب است؛ یک کلیپ خیلی بلند با کیفیت بالا رم زیادی لازم دارد.
- کلیپ‌های انتخاب‌شده با زمان شروعشان مشخص می‌شوند (`reverseStarts`، تطبیق با دقت 1e-6). شروع کلیپ اول ۰ است و شروع بقیه همان زمان برشی است که بازشان می‌کند.

### نام فایل‌ها
`<نام ویدیو>_part_01.mp4` و برای کلیپ‌های انتخاب‌شده `<نام ویدیو>_part_01_reverse.mp4`. نام ویدیو در `safeBaseName` از نویسه‌های غیرمجاز ویندوز پاک می‌شود و حداکثر ۸۰ نویسه است.

### پیشرفت
هر کلیپ یک گام است و هر نسخه‌ی برعکس یک گام دیگر. درصد از خط `time=` در stderr FFmpeg خوانده می‌شود (`parseFfmpegTime`).

## وضعیت رابط کاربری (`App`)

| state | معنی |
|---|---|
| `video` | انتخاب فعلی (`name`، `url`، `fps`) |
| `duration`، `currentTime` | از رویدادهای `<video>` |
| `fps` | از تشخیص خودکار، قابل ویرایش با دست |
| `cutTimes` | زمان برش‌ها، مرتب‌شده |
| `reversedStarts` | زمان شروع کلیپ‌هایی که «برعکس» دارند |
| `isExporting`، `exportProgress`، `notice` | وضعیت خروجی و پیام‌ها |

- `segments` از روی `cutTimes` و `duration` محاسبه می‌شود.
- برش جدید وسط یک کلیپ تیک‌خورده، تیک را به نیمه‌ی دوم هم می‌دهد.
- حذف یک برش دو کلیپ را یکی می‌کند. کلیپ حاصل انتخاب کلیپ اول را نگه می‌دارد.
- باز کردن ویدیوی جدید همه‌چیز را صفر می‌کند.

## ساخت و انتشار

```powershell
npm install
npm run dev        # Vite + tsc --watch + Electron با سرور توسعه
npm run typecheck  # tsc -b و tsc برای electron
npm run lint
npm run build      # typecheck + vite build + tsc electron
npm run package    # build + electron-builder --dir  → release/win-unpacked
npm run dist       # build + electron-builder       → release/Boresh-Setup-<نسخه>.exe
```

- FFmpeg در بسته‌ی نهایی باید بیرون از `app.asar` بماند (`asarUnpack`). `getFfmpegPath` در حالت بسته‌شده، مسیر را به `app.asar.unpacked` تبدیل می‌کند.
- نصب‌کننده حدود ۱۳۴ مگابایت است و امضای دیجیتال تجاری ندارد. ویندوز در اولین اجرا هشدار SmartScreen نشان می‌دهد.
- اگر برنامه از `release\win-unpacked` باز باشد، `npm run package` و `npm run dist` با خطای `EPERM` متوقف می‌شوند و پوشه را نیمه‌پاک می‌گذارند. اول برنامه را ببندید.
- Telegram برای ربات‌ها حداکثر ۵۰ مگابایت را می‌فرستد. برای فرستادن نصب‌کننده، با 7-Zip یک zip چندتکه‌ی ۴۵ مگابایتی ساخته شد.

## تست

تست خودکار در پروژه نیست. تغییرات اخیر این‌طور بررسی شده‌اند:

1. ساخت ویدیوی آزمایشی با FFmpeg همراه برنامه: `testsrc2` در ۳۰ و ۲۹٫۹۷ FPS. هر فریم آن شمارنده‌ی متفاوتی دارد.
2. اجرای خود `dist-electron/main.js` در Electron، با دیالوگ‌های فایل جایگزین‌شده، و فرستادن کلیک و کلید واقعی با `webContents.sendInputEvent`.
3. خواندن فریمی که واقعاً نمایش داده شده با `requestVideoFrameCallback`، و مقایسه با تایم‌کد.
4. باز کردن خروجی‌ها با PyAV و تطبیق هر فریم با فریم‌های منبع: پوشش کامل بدون تکرار، و نسخه‌ی برعکس دقیقاً به ترتیب معکوس.

این روش با ویدیوی HEVC ده‌بیتی ۱۰۸۰p با صدا هم تکرار شد.

## محدودیت‌ها و ایده‌ها

- تشخیص FPS از متن خروجی FFmpeg است. برای ویدیوهای با نرخ فریم متغیر، دقت حرکت فریم به FPS واردشده بستگی دارد.
- خروجی همیشه دوباره رمزگذاری می‌شود (H.264 با CRF 18). کپی بدون رمزگذاری فقط روی فریم‌های کلیدی دقیق است.
- `reverse` کل کلیپ را در رم نگه می‌دارد. برای کلیپ‌های بلند می‌شود کلیپ را تکه‌تکه برعکس کرد و تکه‌ها را به هم چسباند.
- ایده: انتخاب کیفیت یا کدک خروجی، خروجی مستقیم با نام‌گذاری پروژه‌ی تور (`N1_N2.mp4`)، و لغو خروجی در حال اجرا.
