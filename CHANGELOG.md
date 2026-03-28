# Changelog

## [0.1.2] - 2026-03-28

### Changed
- Expanded README with build-from-source installation instructions

### Added
- Demo GIF (`demo.gif`) in README showcasing the extension in action
- Sample IPC files (`people.ipc`, `events.ipc`) in `samples/` for easy onboarding

## [0.1.1] - 2026-01-14

### Changed
- Datetime and timestamp columns now display in human-readable format instead of epoch integers
- Timestamps with timezone show local time (e.g., `2024-01-02 16:00:00` for America/New_York)
- Timestamps without timezone show UTC (e.g., `2024-01-02 21:00:00.000 UTC`)
- Date columns show `YYYY-MM-DD` format
- Min/max statistics for temporal columns also display formatted values

## [0.1.0] - 2026-01-11

### Added
- Initial release
- View Arrow IPC file schema (column names, data types, nullable)
- Preview first N rows of data (configurable via `previewRows` setting)
- Column statistics: null count, distinct count, min/max values
- Separate schema and statistics tables
- File-level and field-level metadata display
- Configurable `statsThresholdMB` setting to skip expensive stats on large files
- File size display with memory safety (files >100MB show warning)
- esbuild bundling for proper extension packaging
- Unit tests with vitest
