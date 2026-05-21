# Blueprint — Project Documentation

## Overview

A web-based capacity planning tool for managing engineering team workload across verticals (Growth, Sportsbook, Casino, Account, Payments). Projects are sized in T-shirt sizes, allocated to swimlane tracks (Core Bonus, Gateway, SEO & AFF), and visualized on a drag-and-drop roadmap with a timeline/Gantt view.

**Tech Stack**: Single-file React SPA (no build system) + Express.js API + JSON file storage
**Auth**: Google Sign-In restricted to @novibet.com
**Deployment**: Vercel (frontend), Railway (API + persistent volume at `/data`)

---

## Architecture

```
index.html          (5500+ lines) — Single-file React 18 app via CDN + Babel
audit.html          — Standalone audit log viewer
vercel.json         — SPA routing config
api/
  server.js         (1500+ lines) — Express.js API with WebSocket support
  package.json      — Dependencies: express, cors, ws; devDeps: jest, supertest
  __tests__/        — Test suite (500 tests across 10 files)
shared/
  computations.js   — Pure computation functions shared by frontend + tests
```

**CDN Dependencies** (loaded in index.html):
- React 18.2.0, ReactDOM 18.2.0, Babel 7.23.9
- XLSX 0.18.5 (SheetJS) for Excel import
- Google Sign-In API

**API URL**: `https://capacity-planner-production-1cf7.up.railway.app`
**GitHub**: `https://github.com/iOnRails/capacity-planner.git`

---

## Data Model

### Project Schema
```json
{
  "id": 1,
  "nvrd": "PGR-362",
  "masterEpic": "Marketplace",
  "subTask": "[Marketplace] CY Expansion",
  "pillar": "Expansion",
  "targetMarket": "CY",
  "targetKPI": "Revenue",
  "impact": "L",
  "backend": "S",
  "frontend": "XS",
  "natives": "S",
  "qa": "S",
  "inProgress": true,
  "status": "in_progress",
  "percentComplete": 45,
  "sprintOverrides": { "backend": 3.5, "qa": 2 }
}
```

Valid statuses: `not_started` (default), `in_progress`, `paused`
`percentComplete`: 0-100 integer (only meaningful when status is `in_progress` or `paused`)

Valid sizes: `""`, `XS`, `S`, `M`, `L`, `XL`, `XXL`, `XXXL`
Valid pillars: Expansion, Acquisition, Core Platform, Comms, Gamification, Core Bonus
Valid KPIs: Revenue, Efficiency, Experience

### Vertical State (per vertical, stored as `state_{key}.json`)
```json
{
  "capacity": { "backend": 40, "frontend": 30, "natives": 25, "qa": 20 },
  "tracks": {
    "core-bonus": [1, 6, 7],
    "gateway": [13, 14],
    "seo-aff": [37, 38]
  },
  "trackCapacity": {
    "core-bonus": { "backend": 0, "frontend": 0, "natives": 0, "qa": 0 },
    "gateway": { "backend": 0, "frontend": 0, "natives": 0, "qa": 0 },
    "seo-aff": { "backend": 0, "frontend": 0, "natives": 0, "qa": 0 }
  },
  "splits": {
    "6": { "gateway": { "backend": "S", "frontend": "", "natives": "", "qa": "" } }
  },
  "timelineConfig": {
    "sprintStartDate": "2026-02-26",
    "sprintDurationWeeks": 2,
    "timeScale": "months"
  },
  "milestones": [{ "id": 1, "name": "Q1 Release", "date": "2026-03-31", "color": "#e84393" }],
  "timelineOverrides": {
    "core-bonus:6": { "startSprints": 2, "durationSprints": 5 }
  },
  "timelineLaneAssignments": { "core-bonus:6": 0 },
  "trackSubLaneCounts": { "core-bonus": 2 },
  "trackBlockOrder": {
    "core-bonus": ["1", "6", "ghost:7", "10"],
    "gateway": ["13", "14"]
  },
  "splitStatuses": {
    "6": { "gateway": { "status": "in_progress", "percentComplete": 45 } }
  },
  "buffer": { "backend": 0, "frontend": 0, "natives": 0, "qa": 0 },
  "quarterlyCapacity": {
    "Q1 2026": { "backend": 40, "frontend": 30, "natives": 25, "qa": 20 },
    "Q2 2026": { "backend": 46, "frontend": 32, "natives": 25, "qa": 22 }
  },
  "quarterlyTrackCapacity": {
    "Q1 2026": {
      "core-bonus": { "backend": 20, "frontend": 15, "natives": 10, "qa": 8 },
      "gateway": { "backend": 12, "frontend": 10, "natives": 8, "qa": 6 }
    }
  },
  "_fieldTs": { "tracks": 1708900000000, "trackBlockOrder": 1708900001000 },
  "updatedAt": "2026-02-26T10:00:00.000Z"
}
```

### Size Map (default, configurable per session)
| Size | Sprints |
|------|---------|
| XS   | 0.5     |
| S    | 1       |
| M    | 2       |
| L    | 3       |
| XL   | 5       |
| XXL  | 8       |
| XXXL | 13      |

---

## API Endpoints

### Projects
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/verticals/:key/projects` | Get all projects for a vertical |
| POST/PUT | `/api/verticals/:key/projects` | Save projects array (validates sizes) |

### State
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/verticals/:key/state` | Get full state with `_loadedAt` timestamp |
| POST/PUT | `/api/verticals/:key/state` | Save changed fields with conflict resolution |
| GET | `/api/verticals/:key/poll` | Lightweight check: returns `updatedAt` only |

### Workspaces (Snapshots)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/verticals/:key/snapshots` | List snapshot metadata for a vertical |
| POST | `/api/verticals/:key/snapshots` | Save named snapshot (optional `sourceSnapshotId` to branch from another snapshot) |
| GET | `/api/verticals/:key/snapshots/:id` | Get full snapshot (state + projects) for workspace loading |
| PUT | `/api/verticals/:key/snapshots/:id` | Update snapshot state+projects (workspace auto-save) |
| POST | `/api/verticals/:key/snapshots/:id/promote` | Promote snapshot to Masterplan (copies state+projects, broadcasts WS) |
| DELETE | `/api/verticals/:key/snapshots/:id` | Delete a snapshot |

### Editors
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/editors` | Get editor list + pending requests |
| POST | `/api/editors` | Save editor list (admin-only) |
| POST | `/api/editors/request` | Request editor access |

### Comments
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/verticals/:key/projects/:projectId/comments` | Get all comments for a project |
| POST | `/api/verticals/:key/projects/:projectId/comments` | Add a top-level comment (`{ text }`) |
| POST | `/api/verticals/:key/projects/:projectId/comments/:commentId/replies` | Add a reply to a comment (`{ text }`) |
| DELETE | `/api/verticals/:key/projects/:projectId/comments/:commentId` | Delete a comment (author or admin only) |
| GET | `/api/verticals/:key/comments/counts` | Get comment counts for all projects (for badges) |

### Other
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/verticals` | List verticals with project counts |
| GET | `/api/health` | Health check |
| GET | `/api/audit-log` | Query audit log (?user, ?vertical, ?days) |

### WebSocket
- Path: `/ws`
- Client sends: `{ "type": "subscribe", "vertical": "growth" }`
- Server broadcasts full state on save: `{ "type": "update", "vertical": "growth", "updatedAt": "...", "senderId": "abc123", "state": {...}, "projects": [...] }`
- Inline state avoids clients needing an HTTP fetch after WS notification (fixes background-tab throttling)
- Each client has unique `wsIdRef` sent as `X-WS-ID` header to skip own broadcasts
- **Keepalive pings**: Server sends `{ "type": "ping" }` every 25s to prevent proxy idle timeouts; clients respond with `pong`

---

## Conflict Resolution

The server uses **field-level timestamps** (`_fieldTs`) for optimistic concurrency:

1. Client sends `_loadedAt` (timestamp when it last fetched state) + only changed fields
2. For each field:
   - If `fieldTs[field] <= _loadedAt` → **Accept** (no conflict)
   - If conflict on **object field** (tracks, trackBlockOrder, etc.) → **Sub-key merge**: accept client's changed sub-keys, keep server's for the rest
   - If conflict on **primitive/array field** → **Reject**, keep server's version
3. Only bumps `fieldTs[field]` when value actually changes (prevents no-op false conflicts)
4. Returns `{ mergedState, conflicts: [rejected field names] }`

### Client-Side Deep Merge
Before sending, the client does sub-key level merging for object fields:
- Captures `serverSnapshotRef` at change time
- On save, compares local state against captured snapshot to find user-changed sub-keys
- Reads LATEST `serverSnapshotRef` as the merge base
- Overlays only user-changed sub-keys on top of latest server state
- This preserves other users' changes to different sub-keys within the same field

### Snapshot Consistency
The `serverSnapshotRef` stores **migrated/defaulted** values (matching what React state actually holds), not raw server responses. This prevents false "changed" detection from migration artifacts (e.g., `migrateTracks` adding missing track keys).

---

## Frontend Features

### Planner View (main view)
- **Roadmap Lane**: 3 swimlane tracks (Core Bonus, Gateway, SEO & AFF) with drag-and-drop project blocks
- **Backlog Lane**: Unallocated projects
- **Block sizing**: Width proportional to total sprints (min 100px, max 360px)
- **Overflow detection**: Red badge when a project pushes track capacity over allocation
- **Ghost blocks**: Dashed blocks showing split allocations from other tracks
- **Drag reordering**: Reorder blocks within a track (persisted as `trackBlockOrder`)
- **Drag between tracks**: Move projects between swimlanes or to/from backlog
- **Capacity bars**: Per-discipline utilization percentage per track. Track header sums quarterly track allocations across all 4 quarters when quarterly data is set.
- **Overcapacity badges**: Red `⚠ Natives` badge when total discipline demand exceeds total allocation; amber `⚠ Q2 '26` badge when per-quarter demand exceeds quarterly track allocation. Both are clickable — popover shows discipline breakdown with used/cap/overBy.

### Configuration Panel (collapsible tabs)
- **Configuration**: Quarterly team capacity grid (4 quarters × 4 disciplines) + T-shirt size mapping. No flat single-value capacity — quarterly is the primary view.
- **Swimlane Allocation**: Per-quarter collapsible track allocation grids. Each quarter is a separate glass card with track rows, discipline inputs, and "Remaining" validation row. First quarter expanded by default, others collapsed with allocated/total summary. Validation: sum per discipline per quarter ≤ quarterly team capacity.
- **Demand & Buffer**: Total demand view + buffer percentage adjustments
- **Capacity Usage**: Visual bars for all disciplines + total

### Timeline / Gantt View (modal)
- **Ruler**: Weeks, months, or quarters scale
- **Project bars**: Positioned and sized based on sprints, draggable
- **Resize handles**: Left/right handles to adjust start/duration
- **Lane assignment**: Drag vertically to assign sub-lanes
- **Sub-lanes**: Add/remove parallel lanes per track
- **Milestones**: Vertical lines with flags, CRUD operations
- **Auto-layout**: Default positioning based on sprint count, overridable

### Project Settings Modal (⚙)
- **Tabbed interface**: Gear icon (`⚙`) on track blocks and ghost blocks opens a tabbed modal
- **General tab**: Set project status (Not Started / In Progress / Paused) + percentage complete (0-100%)
- **Split tab**: Allocate partial project work to other tracks (hidden for ghost blocks since they are already splits)
- **Ghost block independence**: Ghost (split) blocks have their own status and progress, completely independent from the parent project. Stored in `splitStatuses` state field.
- **Status visuals** applied across all views (roadmap, timeline, quarterly):
  - **Not Started**: Default appearance, no special styling
  - **In Progress**: Green inset border + purple progress bar below the block
  - **Paused**: Desaturated (`filter: saturate(0.3)`) + diagonal stripe overlay + yellow/amber border + pause icon (⏸) overlay + yellow progress bar
  - **Overflow**: Badge only (`⚠ BE·FE`) showing which disciplines exceed capacity — no red border
- **Progress bar**: 5-6px bar at the bottom of each block, purple fill (`var(--accent)`) for in-progress, yellow for paused, fills proportionally to the block's width based on % complete
- **Backward compatible**: Projects without `status` field derive it from `inProgress` boolean

### Projects Table View
- **Editable grid**: Click to edit any cell inline
- **Bulk operations**: Multi-select + bulk field edit/delete
- **Excel import**: .xlsx/.xls/.csv with flexible column mapping (case-insensitive). Matches by NVRD (Jira ID) first, falls back to epic+subTask. Exports/imports sprint override columns.
- **Search**: Filters by subTask, nvrd, masterEpic
- **Filter dropdowns**: Pillar, Epic, Market, KPI, Impact (multi-select)
- **Sorting**: Impact (desc), Effort (desc), Name, Epic, Pillar
- **Add/Delete**: Individual project management + "Add Project" row at bottom of table
- **Sprint override indicator**: Discipline cells show `L (3.5sp)` when a sprint override is set

### Sprint Overrides
- **Coexistence**: Projects keep T-shirt sizes AND can have exact sprint overrides per discipline via `sprintOverrides` object
- **Computation**: `computeProjectSprints()` checks `sprintOverrides` first (`!= null` to allow 0), falls back to T-shirt size
- **Inline editor**: Click sprint total in backlog (block or table view) → popover with 4 discipline inputs showing T-shirt reference + number override
- **Settings modal**: Sprint Overrides section in General tab for roadmap blocks
- **Visual indicator**: Asterisk `*` on block sprint labels when overrides exist
- **Validation**: Server validates `sprintOverrides` keys (only `backend/frontend/natives/qa`) and values (non-negative numbers); `sanitizeProject()` cleans invalid entries before validation

### Backlog Enhancements
- **NVRD column**: Shows Jira ID in backlog table view for searchability
- **Sprint editor**: Clickable sprint cell in table view with `e.stopPropagation()` to prevent comments sidebar opening

### Undo/Redo
- **History stack**: `useRef`-based undo/redo stacks (max 50 entries)
- **Keyboard shortcuts**: `Ctrl+Z` (undo), `Ctrl+Shift+Z` / `Ctrl+Y` (redo)
- **Header buttons**: Undo/Redo buttons with disabled state when stack is empty
- **Skip capture**: `skipUndoRef` prevents capturing state during undo/redo operations
- **Auto-save**: Undo/redo triggers a debounced save to persist the restored state
- Wraps `setVerticalStates` via `setVerticalStatesWithUndo` to capture state before every mutation

### Dashboard View
- **Summary cards**: Total Projects, In Roadmap, In Progress, In Backlog counts
- **Capacity Utilization**: Per-discipline bars showing used vs available sprints
- **Demand vs Supply**: Side-by-side comparison with buffered values
- **Per-Track Breakdown**: Table with allocated/used/remaining per track per discipline
- **Projects by Pillar**: Horizontal bar chart
- **Projects by Impact Size**: Bar chart (XS through XXXL)
- **Size Map Reference**: Grid showing current T-shirt size → sprint mappings
- Accessible via "Dashboard" tab in the header

### Masterplan + Workspaces
The **Masterplan** is the permanent, non-deletable live roadmap per vertical (stored in `state_{vertical}.json` / `projects_{vertical}.json`). **Snapshots** are editable workspace copies.

- **Workspace switching**: Each user independently works on Masterplan or a snapshot workspace
- **Auto-save routing**: `saveState`/`saveProjects` route to snapshot PUT endpoint when on a workspace; all ~40 `debouncedSave` call sites work unchanged
- **WS/poll guards**: Masterplan sync (WS, poll, visibility) is skipped when on a snapshot workspace
- **Promote**: Copy snapshot state+projects to overwrite the Masterplan, broadcasts to all users
- **Create from snapshot**: `sourceSnapshotId` parameter branches a new snapshot from an existing one
- **Header indicator**: Green "Masterplan" label or blue snapshot name + "Back to Masterplan" + "Promote" buttons
- **Modal UI**: "Workspaces" button in header → modal with Masterplan shown first (non-deletable), snapshots with "Open" action
- Stored server-side as `snapshots_{vertical}.json`

### Editor Access Control
- **Editor access**: Editors are managed per-vertical; non-editors get read-only access; users can request access

### Quarterly View (modal)
- **Gantt-style blocks**: Projects positioned by `leftPct`/`widthPct` across quarters
- **Aggregated status/progress**: Merges parent + all split statuses — most active status wins (`in_progress > paused > not_started`), progress is averaged across parent + splits
- **Swimlane tracks**: Same 3 tracks as roadmap, each with sub-lanes

### Delivery Board (modal)
- **Quarter columns**: 5 columns (4 rolling quarters + "Later") showing projects grouped by their end date
- **Effort-based tile sizing**: Tile area reflects total effort sprints (`computeProjectSprints().total` — sum of all discipline sizes), not timeline span
- **Masonry layout**: Bin-packing algorithm with 2-column shortest-first placement; above-median projects get full width, below get half width
- **Pillar colors**: Tiles use `CP.getBlockBg(pillar, pillarColorMap)` — no status/progress overlays
- **Per-vertical zoom**: Zoom slider (50–250%) stored per vertical in `deliveryZoomMap`; magnifier icon resets to 100%
- **Interactions**: Click tile → opens comments sidebar; comment count badges shown; fullscreen toggle
- **Flat list**: No track grouping — projects from all tracks appear in a single mosaic per quarter

### Comments Sidebar
- **Click to open**: Clicking any project block (roadmap, backlog, ghost, timeline, quarterly) opens a 400px sidebar from the right
- **Comment threads**: Each project has its own comment thread with author avatar, name, and relative timestamps
- **Replies**: Single-level threaded replies under each comment; inline reply input with Enter-to-submit
- **Delete**: Authors can delete their own comments; admin can delete any
- **Comment badges**: `💬 N` badge on blocks showing comment count across all views
- **Click vs drag**: Roadmap/backlog use HTML5 drag (auto-suppresses `onClick`); timeline uses 5px movement threshold in `handleBarDragStart`; quarterly has no drag conflict
- **Data isolation**: Comments stored per-vertical in `comments_{vertical}.json`, not included in snapshots/workspaces
- **Auth headers**: `X-User-Email`, `X-User-Name`, `X-User-Picture` sent on every request (picture used for avatar storage)
- **Keyboard**: Enter to submit (Shift+Enter for newline), Escape to close (settings modal takes priority)
- **Auto-close**: Sidebar closes on vertical switch; counts re-fetched on vertical load

### Quarterly Capacity Planning
- **Team capacity per quarter**: `quarterlyCapacity` state field — rolling 4 quarters from current quarter, each with `{ backend, frontend, natives, qa }` sprint values
- **Track allocation per quarter**: `quarterlyTrackCapacity` state field — per-quarter per-track allocation with same structure as `trackCapacity` but nested under quarter keys
- **Configuration UI**: Quarterly grid (4 quarters × 4 disciplines) replaces flat team capacity inputs; always visible in config tab
- **Swimlane Allocation UI**: Per-quarter collapsible glass cards, each with full track allocation grid + "Remaining" validation row
- **Track header integration**: Track capacity bars sum quarterly track allocations across all 4 quarters; per-quarter overcapacity badges compare demand against quarterly allocation
- **Data-only**: Quarterly values are stored and displayed; existing flat `capacity`/`trackCapacity` remain as fallback when quarterly data isn't set
- **Audit logging**: Per-quarter per-discipline and per-quarter per-track per-discipline change narratives
- **Glassmorphism styling**: Glass-effect backgrounds with backdrop-blur on config sections, allocation grids, demand cards, and capacity bars

### Auth
- Google Sign-In with @novibet.com domain restriction
- JWT decode (no server-side verification)
- Auto-refresh on expiration
- Audit log link visible only for specific admin email

### Real-time Sync
- **WebSocket**: Full-state broadcast — server sends state + projects inline with WS messages
- **Keepalive pings**: Server pings every 25s, client responds with pong (prevents proxy idle disconnect)
- **Deferred sync**: If a WS/poll notification arrives during an in-flight save, sync runs after save completes
- **Cancel pending save**: When server has newer data, pending local debounced saves are cancelled
- **Fallback poll**: 30-second interval lightweight poll endpoint
- **Visibility change**: Immediate sync when tab becomes visible
- **Debounced saves**: 800ms debounce, captures state at change time
- **Beacon API**: Flushes pending saves on page unload

---

## Verticals & Tracks

**5 Verticals**: Growth, Sportsbook, Casino, Account, Payments
**3 Tracks per vertical**: Core Bonus, Gateway, SEO & AFF — all use neutral gray (`#636e72`) headers to avoid clashing with vibrant pillar colors on project blocks
**4 Disciplines**: Backend, Frontend, Natives, QA

Each vertical has independent projects, state, and capacity configuration.

---

## Key Implementation Notes

### Single-File Architecture
The entire frontend is in `index.html` — no build system, no bundler. React and Babel are loaded from CDN. This means:
- All components are in one file (search by function name)
- State management is via React hooks (useState, useRef, useCallback, useMemo)
- No module imports — everything is in global scope or closure

### Data Persistence
- JSON files on Railway's persistent volume (`DATA_DIR=/data`)
- No database — reads/writes are synchronous `fs.readFileSync`/`fs.writeFileSync`
- File naming: `projects_{vertical}.json`, `state_{vertical}.json`, `snapshots_{vertical}.json`, `comments_{vertical}.json`, `editors.json`, `audit_log.json`

### Migration Functions
- `migrateTracks()`: Renames legacy 'gamification' → 'gateway', ensures all 3 track keys exist
- `migrateTrackCapacity()`: Ensures all 3 track keys exist with zero defaults
- `migrateTrackConfigColors()`: Converts old vibrant track colors (`#fdcb6e`, `#e84393`, `#00b894`) to neutral gray (`#636e72`); applied during state loading

### Known Issues / In Progress
- **Multi-tab sync**: WebSocket notifications work but the underlying conflict resolution for simultaneous edits to the same object field (e.g., two users reordering different tracks within `trackBlockOrder`) can still lose changes in edge cases. The sub-key merge on both client and server handles most cases but rapid concurrent edits to the same field remain challenging.
- **Console logging**: Debug logs (`[ws]`, `[sync]`, `[save]`, `[deepMerge]`, `[merge]`) are still present for diagnostics

---

## Environment Variables (Railway)

| Variable | Value | Description |
|----------|-------|-------------|
| `PORT` | 3000 (default) | Server port |
| `CORS_ORIGIN` | `*` | Allowed origins |
| `DATA_DIR` | `/data` | Persistent volume path |

---

## Audit System

All state and project changes are logged to `audit_log.json` with:
- User email and name (from Google auth headers)
- **Rich narrative descriptions**: Human-readable diffs with project name resolution (e.g., "Moved [Marketplace] CY Expansion to Core Bonus", "Changed Backend capacity from 40 to 46 SP")
- **Structured diffs**: `{ summary, diffs[] }` format — summary has first 2 narratives + "and N more", diffs array has all individual change narratives
- Helper functions: `buildNarratives()` (per-field narrative generation), `findMovedItem()` (detects reorders in arrays), `summarizeValue()` (truncates long objects)
- Vertical, method, endpoint
- Auto-pruned after 30 days
- Queryable via `GET /api/audit-log?user=&vertical=&days=`
- Standalone viewer at `audit.html`

## Testing

- **500 tests** across 10 test files in `api/__tests__/`
- `computations.test.js` (141+ tests) — Shared pure functions (sizeToSprints, projectSprints, effectiveSprints, deepMerge, migration, capacity, overflow, filter/sort, getProjectStatus, getPercentComplete, getSplitStatus, getSplitPercentComplete, sprintOverrides)
- `helpers.test.js` (62 tests) — loadJSON, saveJSON, buildNarratives, findMovedItem, summarizeValue, describeStateChanges, logAudit
- `api.test.js` (72+ tests) — All REST endpoints, validation, conflict resolution (incl. mixed accept/reject, force overwrite, status/percentComplete validation, sprintOverrides validation/sanitization)
- `sanitization.test.js` (30 tests) — Input sanitization and XSS prevention
- `snapshots.test.js` (23 tests) — Snapshot CRUD, workspace GET/PUT, promote, sourceSnapshotId, audit logging
- `comments.test.js` (25 tests) — Comments CRUD, replies, deletion permissions (author/admin), counts, validation, text sanitization, per-project and per-vertical isolation
- `websocket.test.js` (11 tests) — WS subscribe, broadcast, sender exclusion, multi-client, disconnect
- Run: `npm test` (or `npm run test:unit`, `test:integration`, `test:ws`, `test:snapshots`, `test:computations`)
- `require.main === module` guard on server allows test imports without starting the listener
