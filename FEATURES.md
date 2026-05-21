# Blueprint — Feature Documentation

A capacity planning tool for engineering teams to manage project prioritization, resource allocation, and timeline visualization across multiple product verticals.

**Live URLs:**
- Frontend: https://capacity-planner-amber.vercel.app
- API: https://capacity-planner-production-1cf7.up.railway.app
- Repository: https://github.com/iOnRails/capacity-planner

---

## Architecture

The app is a single-page React 18 application (`index.html`) with Babel standalone transpilation (no build step), backed by an Express.js API (`api/server.js`) with WebSocket real-time sync. Data is persisted as JSON files on the server.

| Layer | Technology | File(s) |
|-------|-----------|---------|
| Frontend | React 18 + Babel standalone (CDN) | `index.html` |
| Audit Log Viewer | React 18 + Babel standalone | `audit.html` |
| API | Express.js + WebSocket (ws) | `api/server.js` |
| Data Storage | JSON files on disk | `api/data/*.json` |
| Auth | Google OAuth (domain-restricted) | Embedded in `index.html` |
| Hosting | Vercel (frontend) + Railway (API) | `vercel.json` |

---

## Core Features

### 1. Multi-Vertical Support

The planner supports 5 independent product verticals, each with its own projects, state, and capacity settings: **Growth**, **Sportsbook**, **Casino**, **Account**, and **Payments**.

- Vertical selector in the header allows switching between verticals
- Each vertical has independent projects, state, and configuration
- Data files: `projects_{vertical}.json` and `state_{vertical}.json`
- API routes are namespaced: `/api/verticals/:key/...`

### 2. Project Management

Projects are the core data entity. Each project has metadata fields and size estimations per discipline.

**Project Fields:**
- `id` (required) — unique identifier
- `nvrd` — external reference ID (e.g., JIRA)
- `masterEpic` — parent epic grouping
- `subTask` — project name/description
- `pillar` — strategic pillar (Expansion, Acquisition, Comms, Core Platform, Gamification, Core Bonus)
- `targetMarket` — target market (GR, BR, CY, MX, Global)
- `targetKPI` — target metric (Revenue, Experience, Efficiency)
- `impact` — estimated impact size (XS to XXXL)
- `backend`, `frontend`, `natives`, `qa` — discipline size estimates (XS to XXXL)
- `inProgress` — whether work has started (kept in sync with `status` for backward compatibility)
- `status` — project status: `not_started` (default), `in_progress`, or `paused`
- `percentComplete` — completion percentage (0-100), only meaningful when status is `in_progress` or `paused`

**Validation:** Size fields accept only: empty, XS, S, M, L, XL, XXL, XXXL.

**Files:** `api/server.js` (saveProjectsHandler, lines 601-653), `index.html` (project editing components)

### 3. Capacity Management

Team capacity is configured per discipline (Backend, Frontend, Natives, QA) as story points. Capacity can be set at the global level and overridden per swimlane track.

- **Global capacity:** Total SP available per discipline per sprint
- **Track capacity:** Optional per-track overrides (e.g., Gateway Backend gets 15 SP)
- **Buffer:** Additional buffer SP per discipline to account for unplanned work
- **Size map:** Configurable mapping from t-shirt sizes to story points (e.g., M = 8 SP)

**State fields:** `capacity`, `trackCapacity`, `buffer`, `sizeMap`

### 4. Swimlane Tracks (Roadmap)

Projects are organized into 3 swimlane tracks for the roadmap view: **Core Bonus**, **Gateway**, and **SEO & Affiliates**.

- Projects can be dragged between tracks and within tracks to reorder
- Each track shows its assigned projects as blocks with color-coded discipline bars
- Track capacity bars show used vs. available capacity per discipline
- Unallocated and overflow indicators per track

**State fields:** `tracks` (project ID assignments), `trackBlockOrder` (display ordering)

### 5. Drag-and-Drop Ordering

Blocks within each swimlane track can be reordered via drag-and-drop.

- Supports dragging regular project blocks and ghost/split blocks
- Can drag to start, end, or between existing blocks
- Block order is persisted per track in `trackBlockOrder`
- Ghost blocks (split portions) use the `ghost:{projectId}` key format

**State field:** `trackBlockOrder`

### 6. Project Settings Modal & Splits

A gear icon (`⚙`) on each track block **and ghost block** opens a tabbed **Project Settings Modal**:

**General Tab — Status & Progress:**
- Three status options via radio buttons: **Not Started** (default), **In Progress**, **Paused**
- When In Progress or Paused, a **% Complete** field (0-100) appears
- Status changes are saved immediately to the project data
- `inProgress` boolean is kept in sync for backward compatibility
- **Ghost blocks have independent status** — a parent project can be 80% in-progress while its split hasn't started

**Split Tab — Track Allocation (hidden for ghost blocks):**
- A project can be "split" across two swimlane tracks
- Split configuration: target track + SP allocation per discipline
- Creates a "ghost block" in the target track representing the split portion
- Ghost blocks appear in the ordering as `ghost:{projectId}`
- Split can be created, modified, or removed

**Visual indicators** (applied in roadmap, timeline, and quarterly views):
- **Not Started**: Default appearance, no special styling
- **In Progress**: Green inset border (`box-shadow: inset 0 0 0 2px var(--green)`) + purple progress bar (`var(--accent)`) at block bottom
- **Paused**: Desaturated (`filter: saturate(0.3) brightness(0.85)`), diagonal stripe overlay (`::before` pseudo-element), yellow/amber border (`var(--yellow)`), centered pause icon (`⏸`) overlay (26px roadmap, 18px timeline/quarterly), yellow (`#fdcb6e`) progress bar
- **Overflow**: Badge only (`⚠ BE·FE`) showing which disciplines exceed capacity — no red border styling
- **Progress bar**: 5-6px bar at the bottom of each block, purple fill for in-progress, yellow for paused, fills proportionally based on % complete

**Project fields:** `status` (`not_started` | `in_progress` | `paused`), `percentComplete` (0-100)
**State fields:** `splits` — `{ projectId: { targetTrack: { backend, frontend, natives, qa } } }`, `splitStatuses` — `{ projectId: { targetTrack: { status, percentComplete } } }`

**Files:** `index.html` (settings modal, block rendering), `shared/computations.js` (`getProjectStatus`, `getPercentComplete`, `getSplitStatus`, `getSplitPercentComplete`)

### 7. Timeline View

A Gantt-style timeline showing project bars positioned across sprints/weeks.

- Configurable total weeks and sprint duration
- Project bars can be dragged to adjust start/end positions
- Timeline overrides allow manual positioning of bars
- Lane assignments control which row each project appears in
- Sub-lane counts allow multiple rows per track

**State fields:** `timelineConfig`, `timelineOverrides`, `timelineLaneAssignments`, `trackSubLaneCounts`

### 8. Milestones

Named markers on the timeline at specific week positions with configurable colors.

- Add/remove milestones with label, week number, and color
- Displayed as vertical lines on the timeline view

**State field:** `milestones` — `[{ label, week, color }]`

### 9. Google OAuth Authentication

Domain-restricted authentication via Google Sign-In.

- Allowed domain: `novibet.com`
- Admin email: `kmermigkas@novibet.com`
- Google Client ID: `487456084105-01l0m47e7up61qb40sf2v7gtjmrp6hqt.apps.googleusercontent.com`
- Auth stored in localStorage (`cp_google_auth`)
- User email and name sent to API via `X-User-Email` and `X-User-Name` headers

**File:** `index.html` (AuthGate component)

### 10. Real-Time WebSocket Sync

Multi-tab and multi-user real-time sync using WebSocket with full-state broadcasting.

- Clients subscribe to a vertical: `{ type: 'subscribe', vertical: '...' }`
- On state/project save, server broadcasts full state + projects to all subscribed clients
- Broadcast includes `senderId` (from `X-WS-ID` header) so the originating tab can skip its own update
- Keepalive pings every 25 seconds prevent Railway/proxy from closing idle connections
- Welcome message `{ type: 'connected' }` sent on connection

**Server:** `api/server.js` (WebSocketServer, broadcastUpdate, keepalive interval)
**Client:** `index.html` (WebSocket connection management, auto-reconnect)

### 11. Conflict-Free State Merge

The state save system uses a field-level timestamp-based merge strategy to handle concurrent edits.

**How it works:**
1. Client loads state and receives `_loadedAt` timestamp
2. Client sends changed fields with `_loadedAt` when saving
3. Server checks per-field timestamps (`_fieldTs`) against client's `_loadedAt`
4. If field wasn't modified since client loaded → accept client's value
5. If conflict on object field → sub-key merge (client deletions respected, unchanged server keys preserved)
6. If conflict on non-object field (array, primitive) → reject, keep server value
7. No-op saves (identical value) don't bump field timestamps, preventing false conflicts

**Returns:** `{ success, mergedState, conflicts: [...rejected field names] }`

**File:** `api/server.js` (saveStateHandler, lines 496-595)

### 12. Fallback Polling

When WebSocket is unavailable or as a backup, clients poll the server for changes.

- Polls `/api/verticals/:key/poll` every 30 seconds
- Lightweight endpoint returns only `updatedAt` timestamp and project count (no full state)
- Full state fetch only triggered if `updatedAt` has changed
- Disabled while dragging or saving to avoid conflicts

**File:** `index.html` (polling logic), `api/server.js` (poll endpoint)

### 13. Human-Readable Audit Log

Every state and project change is logged with narrative descriptions.

**Narrative format:** Each change produces `{ text, icon }` objects with natural language descriptions.

**Icon categories:**
| Icon | Symbol | Color | Meaning |
|------|--------|-------|---------|
| move | ↔ | Blue | Item moved/reordered |
| plus | + | Green | Item added |
| minus | − | Red | Item removed |
| pencil | ✎ | Yellow | Item modified |
| split | ⑂ | Purple | Project split created |
| arrow-up | ↑ | Green | Value increased |
| arrow-down | ↓ | Red | Value decreased |

**Example narratives:**
- `Moved "SEO Cache Tool Enhancements" to position 2`
- `Changed Backend capacity from 32 to 46 SP`
- `Split "Casino Widget" to Gateway with 4 Backend, 2 Frontend`
- `Added milestone "Sprint Review" at week 4`
- `Changed Gateway sub-lanes from 1 to 3`

**Features:**
- 30-day retention with automatic pruning
- Filterable by user, vertical, and time range
- Expandable entries show detailed change narratives with color-coded icons
- Legacy format fallback for entries created before the narrative system
- Maximum 500 entries per query

**Files:** `api/server.js` (logAudit, describeStateChanges, buildNarratives, findMovedItem), `audit.html` (DiffDetails component)

### 14. Auto-Seeding

The Growth vertical is automatically seeded with 63 sample projects if no data exists, providing a realistic demo dataset.

**File:** `api/server.js` (seed section, lines 347-423)

### 15. Undo / Redo

Client-side undo/redo system that captures vertical state snapshots before each user-initiated mutation.

- **Undo stack:** Max 50 entries, stored in a `useRef` (no persistence across reloads)
- **Redo stack:** Cleared whenever a new action is taken
- **Keyboard shortcuts:** Ctrl+Z (undo), Ctrl+Shift+Z / Ctrl+Y (redo)
- **UI:** Two buttons (↶ ↷) in the header, disabled when stack is empty
- **Scope:** All state mutations (capacity, tracks, splits, milestones, timeline, buffer, block order) — project edits are NOT included
- **Server sync:** Undo/redo saves immediately to the server (not debounced) and skips pushing to the undo stack itself

**File:** `index.html` (undoStackRef, redoStackRef, setVerticalStatesWithUndo, handleUndo, handleRedo)

### 16. Dashboard / Summary View

A dedicated "Dashboard" tab showing capacity analytics and project distribution metrics computed from existing data.

**Dashboard sections:**
1. **Summary Cards** — Total projects, roadmap count, in-progress count, backlog count
2. **Capacity Utilization** — Per-discipline (Backend, Frontend, Natives, QA) bar charts showing used vs. available capacity with buffer applied
3. **Demand vs Supply** — Total demand (all projects) compared to available capacity, highlighting over/under-capacity per discipline
4. **Per-Track Breakdown** — Table showing each track's used/allocated capacity per discipline with utilization percentage
5. **Projects by Pillar** — Distribution of projects across strategic pillars (Expansion, Acquisition, Comms, etc.)
6. **Projects by Impact** — Bar chart showing project count distribution across impact sizes (XS to XXXL)
7. **Size Map Reference** — Current T-shirt size to story point mapping

All data is computed from existing `useMemo` hooks — no additional API calls needed.

**File:** `index.html` (DashboardView component)

### 17. Masterplan + Workspaces

The **Masterplan** is the permanent, non-deletable live roadmap per vertical. It is the single source of truth stored in `state_{vertical}.json` / `projects_{vertical}.json`. Only the Masterplan can be signed off by ExCo.

**Snapshots** are editable workspace copies — per-user playgrounds where changes auto-save without affecting the Masterplan. Snapshots can be "promoted" to overwrite the Masterplan.

- **Workspace switching:** Each user independently switches between Masterplan and snapshot workspaces. Persisted per-user per-vertical in localStorage
- **Save routing:** `saveState`/`saveProjects` check `activeWorkspaceRef.current.type` and route to `PUT /snapshots/:id` when on a workspace — all ~40 `debouncedSave` call sites work unchanged
- **WS/poll/visibility guards:** Masterplan sync is skipped when on a snapshot workspace (prevents overwriting workspace changes)
- **Promote:** `POST /snapshots/:id/promote` copies snapshot state+projects to Masterplan files, broadcasts WS update to all connected clients
- **Branch from snapshot:** `sourceSnapshotId` parameter creates a new snapshot from an existing one
- **Header indicator:** Green "Masterplan" label or blue snapshot name with "Back to Masterplan" and "Promote" buttons (editor-only)
- **Workspaces modal:** "Workspaces" button in header → Masterplan shown first (non-deletable, green indicator), snapshots listed with "Open" action
- **Delete snapshot:** Any editor can delete any snapshot (no ExCo guard)

**Storage:** `snapshots_{vertical}.json` — Array of `{ id, name, description, createdAt, createdBy, state, projects }`

**UI:** "Workspaces" button in header → modal dialog with save form and snapshot list

**Files:** `api/server.js` (snapshot + workspace endpoints), `index.html` (workspace state, save routing, modal)

### 18. ExCo Permission Layer

Admin-managed list of ExCo (Executive Committee) members who have authority to sign off on quarterly plans.

- **Admin panel:** Admin can add/remove ExCo members from the admin settings panel
- **Storage:** `exco.json` — Array of email addresses
- **Validation:** Deduplicates, normalizes to lowercase, filters out admin email and non-@novibet.com addresses
- **Authorization:** ExCo status checked via `isExCoUser()` helper (includes admin as implicit ExCo)

**Endpoints:** `GET /api/exco`, `POST /api/exco` (admin-only)

**Files:** `api/server.js` (ExCo CRUD), `index.html` (admin panel ExCo section)

### 19. Editor Access Control

Per-vertical editor permissions controlling who can modify data.

- **Editor list:** Admin manages editors with per-vertical or `all` access
- **Access requests:** Non-editors can request access; requests appear in admin panel for approval
- **Read-only mode:** Non-editors can view but not modify data
- **Storage:** `editors.json` — Array of `{ email, verticals: ['all'] | ['growth', 'casino', ...] }`

**Endpoints:** `GET /api/editors`, `POST /api/editors` (admin-only), `POST /api/editors/request`

**Files:** `api/server.js` (editor endpoints + auth middleware), `index.html` (access request UI, editor admin panel)

### 20. Sign-Off Versioning & Diff View

Versioned sign-offs stored separately from snapshots, with a diff comparison feature in the quarterly view.

- **Sign-off creation:** ExCo members (or admin) sign off the current Masterplan, capturing quarterly blocks + full state + projects
- **Versioned storage:** Each sign-off is a separate entry in `signoffs_{vertical}.json` with unique ID, label (e.g., "Q1 2026 Sign-Off"), signer info, and timestamp
- **Diff dropdown:** Quarterly modal header has a `<select>` listing all sign-off versions showing label, signer email, and date
- **Diff mode:** Selecting a sign-off version enables diff — ghost blocks from the signed-off version overlay the current Masterplan with NEW/MOVED/REMOVED badges
- **Delete sign-offs:** Admin can delete old sign-off versions via a red trash button next to the dropdown
- **Startup migration:** Existing `signedOff` snapshots are automatically migrated to the signoffs file on server startup

**Storage:** `signoffs_{vertical}.json` — Array of `{ id, label, createdAt, signedOff: { by, name, at }, quarterlyBlocks, state, projects }`

**Endpoints:** `GET /signoffs`, `GET /signoffs/:id`, `POST /signoffs` (ExCo-only), `DELETE /signoffs/:id` (admin-only)

**Files:** `api/server.js` (sign-off endpoints, migration), `index.html` (diff dropdown, sign-off button, diff rendering)

### 21. Quarterly View

A Gantt-style quarterly planning modal showing project blocks positioned across quarters.

- **Modal overlay:** Opened via "Quarterly" button in header, fullscreen-capable
- **Swimlane tracks:** Same 3 tracks as the roadmap (Core Bonus, Gateway, SEO & AFF) with sub-lanes
- **Block positioning:** Projects rendered with `leftPct`/`widthPct` percentages across the quarter timeline
- **Aggregated status/progress:** Quarterly blocks merge parent + all split statuses — most active status wins (`in_progress > paused > not_started`), progress bar shows averaged percentComplete across parent + splits
- **Sign-off button:** Only visible when user is on Masterplan and is ExCo member
- **Diff overlay:** When a sign-off version is selected, ghost blocks from that version are shown with comparison badges (NEW, MOVED, REMOVED)

**Files:** `index.html` (quarterly modal component, quarterlyData computation)

### 22. Delivery Board

A mosaic-style delivery view showing projects grouped by the quarter they finish in, for at-a-glance "what delivers in Q3?" answers.

- **5-column layout:** 4 rolling quarters (Q1–Q4) + "Later" column for projects ending beyond the window
- **End-date bucketing:** Projects placed by their combined end date (parent + splits merged, same as quarterly view)
- **Effort-based tile sizing:** Tile area proportional to total effort sprints (sum of all discipline sizes via `computeProjectSprints`), not timeline span — accurately reflects relative project size
- **Masonry bin-packing:** 2-column shortest-first algorithm; above-median projects get full width, below get half width; produces gap-free photo-mosaic layout
- **Pillar colors:** Tiles use pillar gradient backgrounds (`CP.getBlockBg`), no status/progress overlays
- **Per-vertical zoom:** Zoom slider (50–250%) with independent zoom level per vertical; magnifier icon resets to 100%
- **Interactions:** Click tile → opens comments sidebar; comment count badges (💬 N); fullscreen toggle (⛶)
- **Flat list:** No track grouping — all projects in a single mosaic per quarter column

**Files:** `index.html` (deliveryData useMemo with bin-packing, delivery modal JSX, delivery CSS)

---

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Health check |
| POST | `/api/test-post` | Debug endpoint |
| GET | `/api/verticals` | List all verticals with project counts |
| GET | `/api/verticals/:key/projects` | Get projects for a vertical |
| POST/PUT | `/api/verticals/:key/projects` | Save projects (with validation) |
| GET | `/api/verticals/:key/state` | Get full planner state |
| POST/PUT | `/api/verticals/:key/state` | Save state (with conflict-free merge) |
| GET | `/api/verticals/:key/poll` | Lightweight polling (updatedAt only) |
| GET | `/api/verticals/:key/snapshots` | List snapshots for a vertical |
| POST | `/api/verticals/:key/snapshots` | Save new snapshot (optional `sourceSnapshotId`) |
| GET | `/api/verticals/:key/snapshots/:id` | Get full snapshot for workspace loading |
| PUT | `/api/verticals/:key/snapshots/:id` | Update snapshot (workspace auto-save) |
| POST | `/api/verticals/:key/snapshots/:id/promote` | Promote snapshot to Masterplan |
| DELETE | `/api/verticals/:key/snapshots/:id` | Delete a snapshot |
| GET | `/api/verticals/:key/signoffs` | List sign-off versions |
| GET | `/api/verticals/:key/signoffs/:id` | Get sign-off blocks (supports `latest`) |
| POST | `/api/verticals/:key/signoffs` | Create sign-off version (ExCo-only) |
| DELETE | `/api/verticals/:key/signoffs/:id` | Delete sign-off version (admin-only) |
| GET | `/api/exco` | Get ExCo member list |
| POST | `/api/exco` | Save ExCo list (admin-only) |
| GET | `/api/editors` | Get editor list + pending requests |
| POST | `/api/editors` | Save editor list (admin-only) |
| POST | `/api/editors/request` | Request editor access |
| GET | `/api/audit-log` | Query audit log (?user, ?vertical, ?days) |
| WS | `/ws` | WebSocket for real-time sync |

---

## State Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| `capacity` | `{backend, frontend, natives, qa}` | Global team capacity (SP) |
| `tracks` | `{trackKey: [projectIds]}` | Swimlane track assignments |
| `trackCapacity` | `{trackKey: {discipline: SP}}` | Per-track capacity overrides |
| `splits` | `{projectId: {targetTrack, ...SP}}` | Project split configurations |
| `timelineConfig` | `{totalWeeks, sprintWeeks, ...}` | Timeline display settings |
| `milestones` | `[{label, week, color}]` | Timeline milestone markers |
| `timelineOverrides` | `{projectId: {startWeek, endWeek}}` | Manual bar positions |
| `sizeMap` | `{size: storyPoints}` | T-shirt size to SP mapping |
| `trackSubLaneCounts` | `{trackKey: count}` | Sub-lanes per track |
| `timelineLaneAssignments` | `{projectId: laneIndex}` | Lane assignments |
| `trackBlockOrder` | `{trackKey: [blockKeys]}` | Block display ordering |
| `buffer` | `{backend, frontend, natives, qa}` | Buffer capacity (SP) |

---

## Testing

Tests are located in `api/__tests__/` and run with Jest.

```bash
npm test                # Run all tests
npm run test:unit       # Unit tests only (helpers)
npm run test:integration # API integration tests only
npm run test:ws         # WebSocket tests only
npm run test:coverage   # Run with coverage report
```

**Test coverage (365+ tests across 8 files):**
- **computations.test.js** (131+ tests) — Shared pure functions (sizeToSprints, projectSprints, effectiveSprints, deepMerge, migration, capacity, overflow, filter/sort, getProjectStatus, getPercentComplete, getSplitStatus, getSplitPercentComplete)
- **helpers.test.js** (62 tests) — Unit tests for buildNarratives (all 12 field types), findMovedItem, describeStateChanges, summarizeValue, loadJSON/saveJSON, logAudit
- **api.test.js** (62+ tests) — Integration tests for all endpoints, project validation (incl. status/percentComplete), track cleanup, state merge with conflict resolution, audit log filtering
- **sanitization.test.js** (30 tests) — Input sanitization and XSS prevention
- **snapshots.test.js** (23 tests) — Snapshot CRUD, workspace GET/PUT, promote, sourceSnapshotId, audit log integration
- **exco-signoff.test.js** (21 tests) — ExCo CRUD, sign-off creation/listing/retrieval, admin-only sign-off deletion
- **comments.test.js** (25 tests) — Comments CRUD, replies, deletion permissions (author/admin), counts, validation, text sanitization, per-project and per-vertical isolation
- **websocket.test.js** (11 tests) — WebSocket connection, subscribe/unsubscribe, broadcast on state and project saves, sender exclusion, multi-client sync, disconnection cleanup, invalid message handling

---

## Deployment

- **Frontend (Vercel):** Auto-deploys from GitHub on push. Serves `index.html` and `audit.html`.
- **API (Railway):** Auto-deploy webhook is currently broken. Workaround: disconnect and reconnect the GitHub repo in Railway Settings to force a fresh deploy from the latest commit.

**Railway project:** https://railway.com/project/5fefb7ac-b24a-4cb5-899e-341b0de34f3f
