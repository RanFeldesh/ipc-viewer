# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                    # Install dependencies
npm run compile                # Compile TypeScript (esbuild + sourcemaps)
npm test                       # Run all tests (vitest)
npm test -- --watch            # Watch mode for tests
npm test -- ipcAnalyzer.test   # Run a specific test file
npm run watch                  # Watch mode for compilation
npx @vscode/vsce package       # Build .vsix for distribution
```

## Architecture

VSCode custom readonly editor extension for viewing Apache Arrow IPC (`.ipc`) files. Uses `CustomReadonlyEditorProvider` — files are never modified.

**Data flow:** User opens `.ipc` file → `extension.ts` activates and registers `IpcEditorProvider` → `resolveCustomEditor()` calls `analyzeIpcFile()` → HTML webview rendered with schema table, column statistics table, and data preview table.

- **`src/extension.ts`** — Entry point. Registers the custom editor provider with `retainContextWhenHidden`.
- **`src/ipcEditorProvider.ts`** — Implements `CustomReadonlyEditorProvider`. Reads VSCode settings (`previewRows`, `statsThresholdMB`), orchestrates analysis, and generates all HTML server-side (webview scripts are disabled for security). Uses VSCode theme CSS variables for styling.
- **`src/ipcAnalyzer.ts`** — Pure analysis module (no VSCode dependency). Reads IPC files via `apache-arrow`, extracts schema/metadata, computes column statistics, and returns typed `IpcFileInfo`. Handles temporal formatting (timestamps with/without timezone, dates, times with various units).
- **`src/test/ipcAnalyzer.test.ts`** — Vitest tests using `tableFromArrays()`/`tableToIPC()` to create temp IPC files. Tests cover formatting, analysis, statistics, threshold behavior, and temporal types.

## Key Design Decisions

- **Two-tier memory safety**: Hard limit at 100MB (`MAX_FILE_SIZE_BYTES`) shows only basic file info. Below that, a configurable `statsThresholdMB` controls whether expensive stats (distinct count, min/max) are computed. Null count always works because it's O(1) from Arrow metadata.
- **Min/max type whitelist**: `MIN_MAX_SUPPORTED_TYPES` prefix-matches Arrow type names. Dictionary-encoded columns are excluded due to decoding complexity.
- **Temporal formatting**: Timestamps with timezone render in that timezone; without timezone render as UTC. Date/Time types handle all Arrow unit variants (day, millisecond, second, microsecond, nanosecond).
- **Bundling**: esbuild bundles everything into `out/extension.js` with `vscode` as the only external. No TypeScript compiler used at runtime.

## Testing

- Tests use `vitest` with `fs.mkdtempSync`/`fs.rmSync` for temp directory lifecycle.
- For manual testing: Press F5 in VSCode to launch Extension Development Host, then open `.ipc` files. Sample files in the `samples/` directory.
