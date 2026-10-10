# Workspace instructions

- [x] Verify that the copilot-instructions.md file in the .github directory is created.
- [x] Clarify Project Requirements
- [x] Scaffold the Project
- [x] Customize the Project
- [x] Install Required Extensions
- [x] Compile the Project
- [x] Create and Run Task
- [x] Launch the Project
- [x] Ensure Documentation is Complete

## Project

- This is a Persian RTL desktop video splitter built with Electron, React, TypeScript, and Vite.
- Keep Electron context isolation and sandboxing enabled; expose only narrow typed APIs through `electron/preload.ts`.
- Local videos are served through the restricted `media:` protocol rather than disabling web security.
- FFmpeg is bundled with `ffmpeg-static`; keep its executable unpacked in electron-builder configuration.
- Preserve keyboard controls: `Space` toggles playback, `.` advances one frame, `,` moves back one frame, and `Z` adds a cut.
- Keep all user-facing text in Persian and preserve the established charcoal, teal, and orange design language.

## Validation

- Run `npm run lint` and `npm run build` after code changes.
- Run `npm run package` when changing Electron packaging or FFmpeg integration.
