# Notes for working on this project

"بُرش" (Boresh) is a Persian, right-to-left Electron desktop app. It splits a video into separate MP4 clips at chosen frames, and can also write a reversed copy of chosen clips. User docs: `README.md`. Architecture, frame maths and the FFmpeg commands: `TECHNICAL.md`. History: `CHANGELOG.md`. Keep them up to date when behaviour changes.

## Commands

`npm run dev` (development), `npm run typecheck`, `npm run lint`, `npm run build`, `npm run package` (→ `release/win-unpacked`), `npm run dist` (→ `release/Boresh-Setup-<version>.exe`). Run lint and build after every change. Close the app running from `release/` before `package` or `dist`, or the build fails with EPERM halfway.

## Rules

- Keep `contextIsolation` and `sandbox` on. The renderer only gets the three functions in `electron/preload.cts`. Change the request and response shapes in three places: `electron/main.ts`, `electron/preload.cts` and `src/types/electron.d.ts`.
- The `media:` protocol must answer Range requests (`serveVideo`). Without a 206 response the video cannot seek.
- Frame positions go through `frameAt` and `frameSeekTime` in `src/App.tsx`. Never seek to exactly `n / fps`: Chromium truncates media times to microseconds, so that lands on the previous frame.
- Cuts are stored at a frame's exact start. Exports seek a quarter frame early (`encodeSegment`), so FFmpeg keeps the cut frame.
- Reversed clips need `setpts`, `asetpts` and `-fps_mode passthrough` (`encodeReversed`). Without them FFmpeg repeats and drops frames.
- All user-facing text is Persian. Keep the charcoal, teal and orange look. Keyboard: Space plays and pauses, `.` and `,` step one frame, Z adds a cut. Shortcuts must keep working while the timeline slider or a checkbox has focus.

## Testing

There is no automated test suite. Recent changes were checked by running `dist-electron/main.js` in Electron with the file dialogs stubbed, sending real input with `webContents.sendInputEvent`, and comparing the exported clips' frames with the source using PyAV. A `testsrc2` video made with the bundled FFmpeg has a distinct counter on every frame. `TECHNICAL.md` describes the method.
