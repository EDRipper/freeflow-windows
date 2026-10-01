# FreeFlow for Windows

Free and open source dictation for Windows. A port of [FreeFlow](https://github.com/zachlatta/freeflow) (macOS) to Electron + TypeScript, reusing its Groq transcription and cleanup pipeline.

Hold a hotkey to talk. Your speech is transcribed, cleaned up by an LLM, and pasted into whatever text field you were in.

## Status

Early port, under active development. Core pipeline, global hotkey, audio capture, paste, settings, and the Windows installer build are being built out. See the checklist below.

## How it works

1. A global hotkey (hold-to-talk, or tap to toggle) starts recording.
2. Audio is captured and sent to an OpenAI-compatible transcription endpoint (Groq by default).
3. The raw transcript is cleaned up by a chat model, using optional nearby-app context and your custom vocabulary.
4. The result is pasted into the active text field.

Get a free Groq API key at [groq.com](https://groq.com) and paste it into Settings. No FreeFlow server exists; the only data that leaves your machine is the API call to your configured provider.

## Build from source

```
npm install
npm run build        # compile main + preload + bundle renderer
npm start            # run locally
npm run dist:win     # produce a Windows NSIS installer in release/
```

Releases are built on `windows-latest` via GitHub Actions (`.github/workflows/release.yml`) and attached to tagged releases.

## Platform notes

The macOS original uses AppKit/SwiftUI, a `CGEventTap` global hotkey, the Accessibility API for context and paste, and `AVFoundation` audio. None of those exist on Windows, so this port rebuilds that layer: Electron windows/tray, `node-global-key-listener` for the global hotkey, `@nut-tree-fork/nut-js` for the Ctrl+V paste, the Web Audio API for capture, and `safeStorage` (DPAPI) for the API key. The Groq pipeline logic is ported directly.

## Parity checklist

- [ ] Transcription + cleanup pipeline
- [ ] Global hold-to-talk and toggle shortcuts
- [ ] Audio capture + live level overlay
- [ ] Clipboard-preserving paste
- [ ] Settings (provider, models, shortcuts, vocabulary, custom prompt)
- [ ] Encrypted API key storage
- [ ] Windows installer + CI release
- [x] Edit mode (transform a selection by a spoken command)
- [x] Nearby-app context capture (active app + window title)
- [x] Auto-update (electron-updater against GitHub releases)

## License

MIT, same as upstream FreeFlow.
