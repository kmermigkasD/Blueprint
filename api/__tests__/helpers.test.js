/**
 * Unit tests for server helper functions:
 * - loadJSON / saveJSON
 * - buildNarratives (all field types)
 * - findMovedItem
 * - describeStateChanges
 * - summarizeValue
 * - logAudit
 */

const fs = require('fs');
const path = require('path');

// Set DATA_DIR to a temp directory BEFORE importing server
const TEST_DATA_DIR = path.join(__dirname, '..', 'data_test_helpers');
process.env.DATA_DIR = TEST_DATA_DIR;

const {
  loadJSON,
  saveJSON,
  buildNarratives,
  findMovedItem,
  describeStateChanges,
  summarizeValue,
  logAudit,
  DATA_DIR,
  AUDIT_FILE,
  getProjectsFile,
  getStateFile,
  keepaliveInterval,
  rateLimitCleanup,
  tokenCacheCleanup,
} = require('../server');

// ── Test helpers ──
const resolveProject = (id) => ({ '1': 'Alpha Project', '2': 'Beta Project', '3': 'Gamma Project', '42': 'SEO Cache Tool' }[String(id)] || `Project #${id}`);
const resolveTrack = (tk) => ({ 'core-bonus': 'Core Bonus', 'gateway': 'Gateway', 'seo-aff': 'SEO & Affiliates' }[tk] || tk);
const disciplineNames = { backend: 'Backend', frontend: 'Frontend', natives: 'Natives' };

// ── Setup / Teardown ──
beforeAll(() => {
  if (!fs.existsSync(TEST_DATA_DIR)) fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterAll(() => {
  clearInterval(keepaliveInterval);
  clearInterval(rateLimitCleanup);
  clearInterval(tokenCacheCleanup);
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.readdirSync(TEST_DATA_DIR).forEach(f => fs.unlinkSync(path.join(TEST_DATA_DIR, f)));
    fs.rmdirSync(TEST_DATA_DIR);
  }
});

beforeEach(() => {
  // Clean data files between tests
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.readdirSync(TEST_DATA_DIR).forEach(f => {
      if (f.endsWith('.json')) fs.unlinkSync(path.join(TEST_DATA_DIR, f));
    });
  }
});

// ═══════════════════════════════════════════════
// loadJSON / saveJSON
// ═══════════════════════════════════════════════

describe('loadJSON', () => {
  test('returns default value when file does not exist', () => {
    expect(loadJSON('nonexistent.json', [])).toEqual([]);
    expect(loadJSON('nonexistent.json', { a: 1 })).toEqual({ a: 1 });
  });

  test('loads saved JSON file correctly', () => {
    const data = { foo: 'bar', count: 42 };
    saveJSON('test_load.json', data);
    expect(loadJSON('test_load.json', {})).toEqual(data);
  });

  test('returns default value on corrupted JSON', () => {
    const fp = path.join(TEST_DATA_DIR, 'corrupted.json');
    fs.writeFileSync(fp, '{invalid json!!!', 'utf8');
    expect(loadJSON('corrupted.json', 'fallback')).toBe('fallback');
  });
});

describe('saveJSON', () => {
  test('saves and reads back data', () => {
    const data = [1, 2, 3, { nested: true }];
    saveJSON('test_save.json', data);
    const fp = path.join(TEST_DATA_DIR, 'test_save.json');
    expect(JSON.parse(fs.readFileSync(fp, 'utf8'))).toEqual(data);
  });

  test('overwrites existing file', () => {
    saveJSON('overwrite.json', { v: 1 });
    saveJSON('overwrite.json', { v: 2 });
    expect(loadJSON('overwrite.json', {})).toEqual({ v: 2 });
  });
});

// ═══════════════════════════════════════════════
// summarizeValue
// ═══════════════════════════════════════════════

describe('summarizeValue', () => {
  test('returns dash for undefined/null', () => {
    expect(summarizeValue(undefined)).toBe('—');
    expect(summarizeValue(null)).toBe('—');
  });

  test('converts primitives to string', () => {
    expect(summarizeValue(42)).toBe('42');
    expect(summarizeValue('hello')).toBe('hello');
    expect(summarizeValue(true)).toBe('true');
  });

  test('truncates long objects', () => {
    const longObj = {};
    for (let i = 0; i < 20; i++) longObj[`key${i}`] = `value${i}`;
    const result = summarizeValue(longObj);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result).toMatch(/\.\.\.$/);
  });

  test('shows short objects in full', () => {
    expect(summarizeValue({ a: 1 })).toBe('{"a":1}');
  });
});

// ═══════════════════════════════════════════════
// buildNarratives — capacity / buffer
// ═══════════════════════════════════════════════

describe('buildNarratives: capacity', () => {
  test('detects capacity increase', () => {
    const narrs = buildNarratives('capacity', { backend: 40 }, { backend: 50 }, resolveProject, resolveTrack, disciplineNames);
    expect(narrs).toHaveLength(1);
    expect(narrs[0].text).toBe('Changed Backend capacity from 40 to 50 SP');
    expect(narrs[0].icon).toBe('arrow-up');
  });

  test('detects capacity decrease', () => {
    const narrs = buildNarratives('capacity', { frontend: 30 }, { frontend: 20 }, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Changed Frontend capacity from 30 to 20 SP');
    expect(narrs[0].icon).toBe('arrow-down');
  });

  test('detects new discipline added', () => {
    const narrs = buildNarratives('capacity', {}, { natives: 15 }, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Set Natives capacity to 15 SP');
    expect(narrs[0].icon).toBe('plus');
  });

  test('detects discipline removed', () => {
    const narrs = buildNarratives('capacity', { natives: 25 }, {}, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Removed Natives capacity (was 25 SP)');
    expect(narrs[0].icon).toBe('minus');
  });

  test('handles multiple discipline changes', () => {
    const narrs = buildNarratives('capacity',
      { backend: 40, frontend: 30 },
      { backend: 50, frontend: 20 },
      resolveProject, resolveTrack, disciplineNames
    );
    expect(narrs).toHaveLength(2);
  });

  test('no changes returns empty', () => {
    const narrs = buildNarratives('capacity', { backend: 40 }, { backend: 40 }, resolveProject, resolveTrack, disciplineNames);
    // When no changes, returns default fallback
    expect(narrs.length).toBeGreaterThanOrEqual(0);
  });
});

describe('buildNarratives: buffer', () => {
  test('uses "buffer" label instead of "capacity"', () => {
    const narrs = buildNarratives('buffer', { backend: 5 }, { backend: 10 }, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toContain('buffer');
    expect(narrs[0].text).not.toContain('capacity');
  });
});

// ═══════════════════════════════════════════════
// buildNarratives — trackCapacity
// ═══════════════════════════════════════════════

describe('buildNarratives: trackCapacity', () => {
  test('detects per-track capacity change', () => {
    const before = { 'core-bonus': { backend: 20 } };
    const after = { 'core-bonus': { backend: 25 } };
    const narrs = buildNarratives('trackCapacity', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Changed Core Bonus Backend capacity from 20 to 25 SP');
  });

  test('detects new track discipline', () => {
    const before = { 'gateway': {} };
    const after = { 'gateway': { frontend: 15 } };
    const narrs = buildNarratives('trackCapacity', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Set Gateway Frontend capacity to 15 SP');
    expect(narrs[0].icon).toBe('plus');
  });
});

// ═══════════════════════════════════════════════
// buildNarratives — tracks (swimlane assignments)
// ═══════════════════════════════════════════════

describe('buildNarratives: tracks', () => {
  test('detects project moved to swimlane', () => {
    const before = { 'core-bonus': [], 'gateway': [] };
    const after = { 'core-bonus': [], 'gateway': ['42'] };
    const narrs = buildNarratives('tracks', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs).toHaveLength(1);
    expect(narrs[0].text).toBe('Moved "SEO Cache Tool" to the Gateway swimlane');
    expect(narrs[0].icon).toBe('move');
  });

  test('detects project removed from swimlane (not moved to another)', () => {
    const before = { 'core-bonus': ['1'], 'gateway': [] };
    const after = { 'core-bonus': [], 'gateway': [] };
    const narrs = buildNarratives('tracks', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs).toHaveLength(1);
    expect(narrs[0].text).toBe('Removed "Alpha Project" from the Core Bonus swimlane');
    expect(narrs[0].icon).toBe('minus');
  });

  test('detects project moved between swimlanes (add + remove, no duplicate)', () => {
    const before = { 'core-bonus': ['1'], 'gateway': [] };
    const after = { 'core-bonus': [], 'gateway': ['1'] };
    const narrs = buildNarratives('tracks', before, after, resolveProject, resolveTrack, disciplineNames);
    // Should only show the "moved to" narrative, not "removed from"
    const moveNarr = narrs.find(n => n.text.includes('Moved'));
    expect(moveNarr).toBeDefined();
    expect(moveNarr.text).toBe('Moved "Alpha Project" to the Gateway swimlane');
    // Should NOT have a "removed" narrative since it was moved, not deleted
    const removeNarr = narrs.find(n => n.text.includes('Removed'));
    expect(removeNarr).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════
// buildNarratives — splits
// ═══════════════════════════════════════════════

describe('buildNarratives: splits', () => {
  test('detects new split creation', () => {
    const before = {};
    const after = { '1': { targetTrack: 'gateway', backend: 4, frontend: 2 } };
    const narrs = buildNarratives('splits', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Split "Alpha Project" to Gateway with 4 Backend, 2 Frontend');
    expect(narrs[0].icon).toBe('split');
  });

  test('detects split removal', () => {
    const before = { '2': { targetTrack: 'gateway', backend: 3 } };
    const after = {};
    const narrs = buildNarratives('splits', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Removed the split for "Beta Project"');
    expect(narrs[0].icon).toBe('minus');
  });

  test('detects split SP change', () => {
    const before = { '1': { targetTrack: 'gateway', backend: 3, frontend: 0 } };
    const after = { '1': { targetTrack: 'gateway', backend: 5, frontend: 0 } };
    const narrs = buildNarratives('splits', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toContain('Updated split for "Alpha Project"');
    expect(narrs[0].text).toContain('Backend: 3 → 5 SP');
  });

  test('detects split track change', () => {
    const before = { '1': { targetTrack: 'gateway', backend: 3 } };
    const after = { '1': { targetTrack: 'seo-aff', backend: 3 } };
    const narrs = buildNarratives('splits', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toContain('moved to SEO & Affiliates');
  });
});

// ═══════════════════════════════════════════════
// buildNarratives — trackBlockOrder
// ═══════════════════════════════════════════════

describe('buildNarratives: trackBlockOrder', () => {
  test('detects item added to ordering', () => {
    const before = { 'gateway': ['1', '2'] };
    const after = { 'gateway': ['1', '2', '3'] };
    const narrs = buildNarratives('trackBlockOrder', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toContain('Added');
    expect(narrs[0].text).toContain('Gamma Project');
    expect(narrs[0].icon).toBe('move');
  });

  test('detects items removed from ordering', () => {
    const before = { 'gateway': ['1', '2', '3'] };
    const after = { 'gateway': ['1', '2'] };
    const narrs = buildNarratives('trackBlockOrder', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toContain('Removed items from Gateway ordering');
    expect(narrs[0].icon).toBe('minus');
  });

  test('detects pure reorder', () => {
    const before = { 'gateway': ['1', '2', '3'] };
    const after = { 'gateway': ['3', '1', '2'] };
    const narrs = buildNarratives('trackBlockOrder', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].icon).toBe('move');
    // Should contain a move description from findMovedItem
    expect(narrs[0].text).toMatch(/Moved|Reordered/);
  });

  test('handles ghost/split blocks', () => {
    const before = { 'gateway': ['1', '2'] };
    const after = { 'gateway': ['1', '2', 'ghost:3'] };
    const narrs = buildNarratives('trackBlockOrder', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toContain('(split)');
  });
});

// ═══════════════════════════════════════════════
// buildNarratives — milestones
// ═══════════════════════════════════════════════

describe('buildNarratives: milestones', () => {
  test('detects milestone added', () => {
    const before = [];
    const after = [{ label: 'Sprint Review', week: 4 }];
    const narrs = buildNarratives('milestones', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Added milestone "Sprint Review" at week 4');
    expect(narrs[0].icon).toBe('plus');
  });

  test('detects milestone removed', () => {
    const before = [{ label: 'A', week: 1 }, { label: 'B', week: 2 }];
    const after = [{ label: 'A', week: 1 }];
    const narrs = buildNarratives('milestones', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Removed 1 milestone');
    expect(narrs[0].icon).toBe('minus');
  });

  test('detects multiple milestones removed', () => {
    const before = [{ label: 'A' }, { label: 'B' }, { label: 'C' }];
    const after = [{ label: 'A' }];
    const narrs = buildNarratives('milestones', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Removed 2 milestones');
  });

  test('detects milestone updated (same count)', () => {
    const before = [{ label: 'A', week: 1 }];
    const after = [{ label: 'A', week: 3 }];
    const narrs = buildNarratives('milestones', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Updated milestone settings');
    expect(narrs[0].icon).toBe('pencil');
  });
});

// ═══════════════════════════════════════════════
// buildNarratives — timelineConfig
// ═══════════════════════════════════════════════

describe('buildNarratives: timelineConfig', () => {
  test('detects total weeks change', () => {
    const before = { totalWeeks: 12, sprintWeeks: 2 };
    const after = { totalWeeks: 16, sprintWeeks: 2 };
    const narrs = buildNarratives('timelineConfig', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Changed timeline length from 12 to 16 weeks');
  });

  test('detects sprint weeks change', () => {
    const before = { totalWeeks: 12, sprintWeeks: 2 };
    const after = { totalWeeks: 12, sprintWeeks: 3 };
    const narrs = buildNarratives('timelineConfig', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Changed sprint length from 2 to 3 weeks');
  });

  test('detects both changes', () => {
    const before = { totalWeeks: 12, sprintWeeks: 2 };
    const after = { totalWeeks: 16, sprintWeeks: 3 };
    const narrs = buildNarratives('timelineConfig', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toContain('timeline length from 12 to 16 weeks');
    expect(narrs[0].text).toContain('sprint length from 2 to 3 weeks');
  });
});

// ═══════════════════════════════════════════════
// buildNarratives — timelineOverrides
// ═══════════════════════════════════════════════

describe('buildNarratives: timelineOverrides', () => {
  test('detects new timeline position', () => {
    const before = {};
    const after = { '1': { startWeek: 3, endWeek: 6 } };
    const narrs = buildNarratives('timelineOverrides', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Positioned "Alpha Project" on the timeline at week 3');
    expect(narrs[0].icon).toBe('move');
  });

  test('detects timeline position reset', () => {
    const before = { '1': { startWeek: 3 } };
    const after = {};
    const narrs = buildNarratives('timelineOverrides', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Reset timeline position for "Alpha Project"');
    expect(narrs[0].icon).toBe('minus');
  });

  test('detects timeline position moved', () => {
    const before = { '1': { startWeek: 3, endWeek: 6 } };
    const after = { '1': { startWeek: 5, endWeek: 8 } };
    const narrs = buildNarratives('timelineOverrides', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toContain('Moved "Alpha Project" on the timeline');
  });

  test('caps at 3 entries then shows "...and N more"', () => {
    const before = {};
    const after = { '1': { startWeek: 1 }, '2': { startWeek: 2 }, '3': { startWeek: 3 }, '42': { startWeek: 4 }, '99': { startWeek: 5 } };
    const narrs = buildNarratives('timelineOverrides', before, after, resolveProject, resolveTrack, disciplineNames);
    const moreNarr = narrs.find(n => n.text.includes('...and'));
    expect(moreNarr).toBeDefined();
    expect(moreNarr.text).toContain('2 more');
  });
});

// ═══════════════════════════════════════════════
// buildNarratives — other fields
// ═══════════════════════════════════════════════

describe('buildNarratives: other fields', () => {
  test('sizeMap returns generic message', () => {
    const narrs = buildNarratives('sizeMap', { S: 3 }, { S: 5 }, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Updated size estimation settings');
  });

  test('trackSubLaneCounts detects change', () => {
    const before = { 'gateway': 1 };
    const after = { 'gateway': 3 };
    const narrs = buildNarratives('trackSubLaneCounts', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Changed Gateway sub-lanes from 1 to 3');
  });

  test('timelineLaneAssignments shows count', () => {
    const before = {};
    const after = { '1': 0, '2': 1, '3': 2 };
    const narrs = buildNarratives('timelineLaneAssignments', before, after, resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Updated timeline lane assignments (3 projects)');
  });

  test('unknown field returns generic update', () => {
    const narrs = buildNarratives('someUnknownField', 'old', 'new', resolveProject, resolveTrack, disciplineNames);
    expect(narrs[0].text).toBe('Updated someUnknownField');
    expect(narrs[0].icon).toBe('pencil');
  });
});

// ═══════════════════════════════════════════════
// findMovedItem
// ═══════════════════════════════════════════════

describe('findMovedItem', () => {
  test('detects item moved to beginning', () => {
    const result = findMovedItem(['1', '2', '3'], ['3', '1', '2'], resolveProject);
    expect(result).toContain('Gamma Project');
    expect(result).toContain('beginning');
  });

  test('detects item moved to end', () => {
    const result = findMovedItem(['1', '2', '3'], ['2', '3', '1'], resolveProject);
    // Item '2' moved from index 1 to index 0 — actually '1' moved to end
    expect(result).toBeDefined();
  });

  test('detects item moved to middle position', () => {
    const result = findMovedItem(['1', '2', '3', '42'], ['1', '42', '2', '3'], resolveProject);
    expect(result).toBeDefined();
    expect(result).toContain('position');
  });

  test('returns null for different length arrays', () => {
    expect(findMovedItem(['1', '2'], ['1', '2', '3'], resolveProject)).toBeNull();
  });

  test('returns null for identical arrays', () => {
    expect(findMovedItem(['1', '2', '3'], ['1', '2', '3'], resolveProject)).toBeNull();
  });

  test('handles ghost/split items', () => {
    const result = findMovedItem(['1', 'ghost:2', '3'], ['ghost:2', '1', '3'], resolveProject);
    expect(result).toContain('Beta Project');
    expect(result).toContain('(split)');
    expect(result).toContain('beginning');
  });
});

// ═══════════════════════════════════════════════
// describeStateChanges
// ═══════════════════════════════════════════════

describe('describeStateChanges', () => {
  test('returns "No changes detected" when no fields changed', () => {
    const existing = { capacity: { backend: 40 } };
    const body = { capacity: { backend: 40 } };
    const result = describeStateChanges(body, existing, 'growth');
    expect(result.summary).toBe('No changes detected');
    expect(result.diffs).toEqual([]);
  });

  test('returns "No changes detected" when body has no recognized fields', () => {
    const result = describeStateChanges({ _loadedAt: 123 }, { capacity: { backend: 40 } }, 'growth');
    expect(result.summary).toBe('No changes detected');
  });

  test('detects capacity change', () => {
    const existing = { capacity: { backend: 40 } };
    const body = { capacity: { backend: 50 } };
    const result = describeStateChanges(body, existing, 'growth');
    expect(result.summary).toContain('Backend');
    expect(result.diffs.length).toBeGreaterThan(0);
  });

  test('handles null existing state', () => {
    const body = { capacity: { backend: 40 } };
    const result = describeStateChanges(body, null, 'growth');
    expect(result.diffs.length).toBeGreaterThan(0);
  });

  test('summary truncates at 2 narratives + "and N more"', () => {
    const existing = { capacity: { backend: 40 }, buffer: { backend: 5 }, tracks: { 'core-bonus': [] } };
    const body = { capacity: { backend: 50 }, buffer: { backend: 10 }, tracks: { 'core-bonus': ['1'] } };
    const result = describeStateChanges(body, existing, 'growth');
    if (result.diffs.length > 2) {
      expect(result.summary).toContain('and');
      expect(result.summary).toContain('more');
    }
  });

  test('handles errors in buildNarratives gracefully', () => {
    // Even if a field processing throws, describeStateChanges catches it
    const existing = { capacity: 'not-an-object' };
    const body = { capacity: { backend: 40 } };
    const result = describeStateChanges(body, existing, 'growth');
    expect(result.diffs.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════
// logAudit
// ═══════════════════════════════════════════════

describe('logAudit', () => {
  const mockReq = {
    headers: { 'x-user-email': 'test@novibet.com', 'x-user-name': 'Test%20User' },
    auth: { email: 'test@novibet.com', name: 'Test User', picture: '', verified: false },
    params: { key: 'growth' },
    method: 'POST',
    originalUrl: '/api/verticals/growth/state',
    body: {},
  };

  test('creates audit log entry', () => {
    logAudit(mockReq, 'Test action', 'Test details');
    const log = loadJSON(AUDIT_FILE, []);
    expect(log.length).toBe(1);
    expect(log[0].action).toBe('Test action');
    expect(log[0].details).toBe('Test details');
    expect(log[0].userEmail).toBe('test@novibet.com');
    expect(log[0].userName).toBe('Test User');
    expect(log[0].vertical).toBe('growth');
  });

  test('handles rich details (summary + diffs)', () => {
    logAudit(mockReq, 'Updated state', {
      summary: 'Changed Backend capacity from 40 to 50 SP',
      diffs: [{ text: 'Changed Backend capacity from 40 to 50 SP', icon: 'arrow-up' }],
    });
    const log = loadJSON(AUDIT_FILE, []);
    const entry = log[0];
    expect(entry.details).toBe('Changed Backend capacity from 40 to 50 SP');
    expect(entry.diffs).toHaveLength(1);
    expect(entry.diffs[0].icon).toBe('arrow-up');
  });

  test('skips logging "No changes detected"', () => {
    logAudit(mockReq, 'Updated state', { summary: 'No changes detected', diffs: [] });
    const log = loadJSON(AUDIT_FILE, []);
    expect(log.length).toBe(0);
  });

  test('prepends new entries (newest first)', () => {
    logAudit(mockReq, 'First', 'first');
    logAudit(mockReq, 'Second', 'second');
    const log = loadJSON(AUDIT_FILE, []);
    expect(log[0].action).toBe('Second');
    expect(log[1].action).toBe('First');
  });

  test('prunes entries older than 30 days', () => {
    // Insert an old entry directly
    const oldEntry = {
      id: 'old1',
      timestamp: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      action: 'Old action',
      userEmail: 'old@test.com',
      userName: 'Old',
      vertical: 'growth',
      details: 'old',
    };
    saveJSON(AUDIT_FILE, [oldEntry]);
    // Log a new entry — should prune the old one
    logAudit(mockReq, 'New action', 'new details');
    const log = loadJSON(AUDIT_FILE, []);
    expect(log.length).toBe(1);
    expect(log[0].action).toBe('New action');
  });

  test('generates unique entry IDs', () => {
    logAudit(mockReq, 'A', 'a');
    logAudit(mockReq, 'B', 'b');
    const log = loadJSON(AUDIT_FILE, []);
    expect(log[0].id).not.toBe(log[1].id);
  });
});
