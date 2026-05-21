/**
 * Alerts API tests.
 *
 * Tests cover:
 * - GET alerts (empty initially, with filters)
 * - POST alert (create, validation, sanitization)
 * - DELETE alert (author, admin, others)
 * - GET alert counts (totals, byProject)
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');

// Set DATA_DIR before importing server
const TEST_DATA_DIR = path.join(__dirname, '..', 'data_test_alerts');
process.env.DATA_DIR = TEST_DATA_DIR;

if (!fs.existsSync(TEST_DATA_DIR)) fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

const { app, keepaliveInterval, rateLimitCleanup, tokenCacheCleanup, getAlertsFile } = require('../server');

// ── Setup / Teardown ──
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
  fs.readdirSync(TEST_DATA_DIR).forEach(f => {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(TEST_DATA_DIR, f));
  });
  fs.writeFileSync(
    path.join(TEST_DATA_DIR, 'editors.json'),
    JSON.stringify([
      { email: 'alice@novibet.com', verticals: ['all'] },
      { email: 'bob@novibet.com', verticals: ['all'] },
    ])
  );
});

// ═══════════════════════════════════════════════
// GET alerts
// ═══════════════════════════════════════════════

describe('GET /api/verticals/:key/alerts', () => {
  test('returns empty array initially', async () => {
    const res = await request(app).get('/api/verticals/growth/alerts');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toEqual([]);
  });

  test('rejects invalid vertical', async () => {
    const res = await request(app).get('/api/verticals/invalid/alerts');
    expect(res.status).toBe(400);
  });

  test('returns created alerts', async () => {
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Alert 1', level: 'critical' });
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Alert 2', level: 'info' });

    const res = await request(app).get('/api/verticals/growth/alerts');
    expect(res.body.alerts).toHaveLength(2);
    expect(res.body.alerts[0].text).toBe('Alert 1');
    expect(res.body.alerts[1].text).toBe('Alert 2');
  });

  test('filters by projectId', async () => {
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Vertical-level', level: 'info' });
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Project alert', level: 'warning', projectId: 42 });

    const res = await request(app).get('/api/verticals/growth/alerts?projectId=42');
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0].text).toBe('Project alert');
  });

  test('filters by level', async () => {
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Critical one', level: 'critical' });
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Info one', level: 'info' });

    const res = await request(app).get('/api/verticals/growth/alerts?level=critical');
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0].text).toBe('Critical one');
  });

  test('alerts are isolated per vertical', async () => {
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Growth alert', level: 'info' });

    const resGrowth = await request(app).get('/api/verticals/growth/alerts');
    const resCasino = await request(app).get('/api/verticals/casino/alerts');
    expect(resGrowth.body.alerts).toHaveLength(1);
    expect(resCasino.body.alerts).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════
// POST alert
// ═══════════════════════════════════════════════

describe('POST /api/verticals/:key/alerts', () => {
  test('creates alert with correct structure', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .set('X-User-Name', 'Alice Smith')
      .set('X-User-Picture', 'https://example.com/alice.jpg')
      .send({ text: 'Backend team short-staffed', level: 'critical' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.alert).toMatchObject({
      text: 'Backend team short-staffed',
      level: 'critical',
      projectId: null,
      authorEmail: 'alice@novibet.com',
      authorName: 'Alice Smith',
      authorPicture: 'https://example.com/alice.jpg',
    });
    expect(res.body.alert.id).toBeDefined();
    expect(res.body.alert.createdAt).toBeDefined();
  });

  test('creates project-level alert', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Blocked by dependency', level: 'warning', projectId: 7 });

    expect(res.status).toBe(200);
    expect(res.body.alert.projectId).toBe(7);
  });

  test('rejects invalid level', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Test', level: 'urgent' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Level must be');
  });

  test('rejects empty text', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: '', level: 'info' });
    expect(res.status).toBe(400);
  });

  test('rejects missing text', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ level: 'info' });
    expect(res.status).toBe(400);
  });

  test('rejects invalid vertical', async () => {
    const res = await request(app)
      .post('/api/verticals/invalid/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Test', level: 'info' });
    expect(res.status).toBe(400);
  });

  test('strips HTML tags from alert text', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: '<script>alert("xss")</script>Safe text here', level: 'info' });
    expect(res.status).toBe(200);
    expect(res.body.alert.text).not.toContain('<script>');
    expect(res.body.alert.text).toContain('Safe text here');
  });

  test('rejects missing level', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'No level specified' });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════
// PUT (edit) alert
// ═══════════════════════════════════════════════

describe('PUT /api/verticals/:key/alerts/:alertId', () => {
  test('author can edit text', async () => {
    const createRes = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Original', level: 'info' });

    const res = await request(app)
      .put(`/api/verticals/growth/alerts/${createRes.body.alert.id}`)
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Updated text' });
    expect(res.status).toBe(200);
    expect(res.body.alert.text).toBe('Updated text');
    expect(res.body.alert.editedAt).toBeDefined();
  });

  test('author can edit level', async () => {
    const createRes = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Test', level: 'info' });

    const res = await request(app)
      .put(`/api/verticals/growth/alerts/${createRes.body.alert.id}`)
      .set('X-User-Email', 'alice@novibet.com')
      .send({ level: 'critical' });
    expect(res.status).toBe(200);
    expect(res.body.alert.level).toBe('critical');
    expect(res.body.alert.text).toBe('Test'); // text unchanged
  });

  test('admin can edit any alert', async () => {
    const createRes = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Alice alert', level: 'warning' });

    const res = await request(app)
      .put(`/api/verticals/growth/alerts/${createRes.body.alert.id}`)
      .set('X-User-Email', 'kmermigkas@novibet.com')
      .send({ text: 'Admin edit' });
    expect(res.status).toBe(200);
    expect(res.body.alert.text).toBe('Admin edit');
  });

  test('another editor of the same vertical can edit', async () => {
    const createRes = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Protected', level: 'critical' });

    const res = await request(app)
      .put(`/api/verticals/growth/alerts/${createRes.body.alert.id}`)
      .set('X-User-Email', 'bob@novibet.com')
      .send({ text: 'Editor edit' });
    expect(res.status).toBe(200);
    expect(res.body.alert.text).toBe('Editor edit');
  });

  test('non-editor cannot edit', async () => {
    const createRes = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Protected', level: 'critical' });

    const res = await request(app)
      .put(`/api/verticals/growth/alerts/${createRes.body.alert.id}`)
      .set('X-User-Email', 'viewer@novibet.com')
      .send({ text: 'Hacked' });
    expect(res.status).toBe(403);
  });

  test('rejects empty text', async () => {
    const createRes = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Original', level: 'info' });

    const res = await request(app)
      .put(`/api/verticals/growth/alerts/${createRes.body.alert.id}`)
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: '' });
    expect(res.status).toBe(400);
  });

  test('rejects invalid level', async () => {
    const createRes = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Test', level: 'info' });

    const res = await request(app)
      .put(`/api/verticals/growth/alerts/${createRes.body.alert.id}`)
      .set('X-User-Email', 'alice@novibet.com')
      .send({ level: 'urgent' });
    expect(res.status).toBe(400);
  });

  test('returns 404 for non-existent alert', async () => {
    const res = await request(app)
      .put('/api/verticals/growth/alerts/nonexistent')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Test' });
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════
// DELETE alert
// ═══════════════════════════════════════════════

describe('DELETE /api/verticals/:key/alerts/:alertId', () => {
  test('author can delete their own alert', async () => {
    const createRes = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'To delete', level: 'info' });

    const res = await request(app)
      .delete(`/api/verticals/growth/alerts/${createRes.body.alert.id}`)
      .set('X-User-Email', 'alice@novibet.com');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const getRes = await request(app).get('/api/verticals/growth/alerts');
    expect(getRes.body.alerts).toHaveLength(0);
  });

  test('admin can delete any alert', async () => {
    const createRes = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Alice alert', level: 'warning' });

    const res = await request(app)
      .delete(`/api/verticals/growth/alerts/${createRes.body.alert.id}`)
      .set('X-User-Email', 'kmermigkas@novibet.com');
    expect(res.status).toBe(200);
  });

  test('another editor of the same vertical can delete', async () => {
    const createRes = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Protected', level: 'critical' });

    const res = await request(app)
      .delete(`/api/verticals/growth/alerts/${createRes.body.alert.id}`)
      .set('X-User-Email', 'bob@novibet.com');
    expect(res.status).toBe(200);
  });

  test('non-editor cannot delete alert', async () => {
    const createRes = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Protected', level: 'critical' });

    const res = await request(app)
      .delete(`/api/verticals/growth/alerts/${createRes.body.alert.id}`)
      .set('X-User-Email', 'viewer@novibet.com');
    expect(res.status).toBe(403);
  });

  test('deleting non-existent alert returns 404', async () => {
    const res = await request(app)
      .delete('/api/verticals/growth/alerts/nonexistent')
      .set('X-User-Email', 'alice@novibet.com');
    expect(res.status).toBe(404);
  });

  test('rejects invalid vertical', async () => {
    const res = await request(app)
      .delete('/api/verticals/invalid/alerts/someid')
      .set('X-User-Email', 'alice@novibet.com');
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════
// GET alert counts
// ═══════════════════════════════════════════════

describe('GET /api/verticals/:key/alerts/counts', () => {
  test('returns zero counts initially', async () => {
    const res = await request(app).get('/api/verticals/growth/alerts/counts');
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ total: 0, critical: 0, warning: 0, info: 0, promoted: 0, byProject: {} });
  });

  test('returns correct totals by level', async () => {
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'C1', level: 'critical' });
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'C2', level: 'critical' });
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'W1', level: 'warning' });
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'I1', level: 'info' });

    const res = await request(app).get('/api/verticals/growth/alerts/counts');
    expect(res.body.counts.total).toBe(4);
    expect(res.body.counts.critical).toBe(2);
    expect(res.body.counts.warning).toBe(1);
    expect(res.body.counts.info).toBe(1);
  });

  test('returns correct byProject breakdown', async () => {
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'P3 alert', level: 'warning', projectId: 3 });
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'P3 alert 2', level: 'info', projectId: 3 });
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'P7 alert', level: 'critical', projectId: 7 });
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Vertical alert', level: 'info' });

    const res = await request(app).get('/api/verticals/growth/alerts/counts');
    expect(res.body.counts.total).toBe(4);
    expect(res.body.counts.byProject).toEqual({ '3': 2, '7': 1 });
  });

  test('rejects invalid vertical', async () => {
    const res = await request(app).get('/api/verticals/invalid/alerts/counts');
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════
// Promote / Demote
// ═══════════════════════════════════════════════

describe('Alert promote / demote', () => {
  test('alerts default to promoted: false', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Normal alert', level: 'info' });
    expect(res.body.alert.promoted).toBe(false);
  });

  test('can create alert with promoted: true', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Exec alert', level: 'critical', promoted: true });
    expect(res.body.alert.promoted).toBe(true);
  });

  test('can toggle promoted via PUT', async () => {
    const createRes = await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Toggle me', level: 'warning' });
    expect(createRes.body.alert.promoted).toBe(false);

    const promoteRes = await request(app)
      .put(`/api/verticals/growth/alerts/${createRes.body.alert.id}`)
      .set('X-User-Email', 'alice@novibet.com')
      .send({ promoted: true });
    expect(promoteRes.status).toBe(200);
    expect(promoteRes.body.alert.promoted).toBe(true);

    const demoteRes = await request(app)
      .put(`/api/verticals/growth/alerts/${createRes.body.alert.id}`)
      .set('X-User-Email', 'alice@novibet.com')
      .send({ promoted: false });
    expect(demoteRes.status).toBe(200);
    expect(demoteRes.body.alert.promoted).toBe(false);
  });

  test('counts include promoted tally', async () => {
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Normal', level: 'info' });
    await request(app)
      .post('/api/verticals/growth/alerts')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Exec', level: 'critical', promoted: true });

    const res = await request(app).get('/api/verticals/growth/alerts/counts');
    expect(res.body.counts.total).toBe(2);
    expect(res.body.counts.promoted).toBe(1);
  });
});

// ═══════════════════════════════════════════════
// File helper
// ═══════════════════════════════════════════════

describe('getAlertsFile', () => {
  test('returns correct filename', () => {
    expect(getAlertsFile('growth')).toBe('alerts_growth.json');
    expect(getAlertsFile('sportsbook')).toBe('alerts_sportsbook.json');
  });
});
