/**
 * Comments API tests.
 *
 * Tests cover:
 * - GET comments (empty initially)
 * - POST comment (create)
 * - GET comments returns created comments
 * - POST reply to a comment
 * - DELETE comment (author, admin, others)
 * - GET comment counts
 * - Validation (empty text, invalid vertical)
 * - Text sanitization (XSS prevention)
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');

// Set DATA_DIR before importing server
const TEST_DATA_DIR = path.join(__dirname, '..', 'data_test_comments');
process.env.DATA_DIR = TEST_DATA_DIR;

if (!fs.existsSync(TEST_DATA_DIR)) fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

const { app, keepaliveInterval, rateLimitCleanup, tokenCacheCleanup, getCommentsFile } = require('../server');

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
  // Write editors.json so test emails pass authorization middleware
  fs.writeFileSync(
    path.join(TEST_DATA_DIR, 'editors.json'),
    JSON.stringify([
      { email: 'alice@novibet.com', verticals: ['all'] },
      { email: 'bob@novibet.com', verticals: ['all'] },
    ])
  );
});

// ═══════════════════════════════════════════════
// GET comments
// ═══════════════════════════════════════════════

describe('GET /api/verticals/:key/projects/:projectId/comments', () => {
  test('returns empty array for new project', async () => {
    const res = await request(app).get('/api/verticals/growth/projects/1/comments');
    expect(res.status).toBe(200);
    expect(res.body.comments).toEqual([]);
  });

  test('rejects invalid vertical', async () => {
    const res = await request(app).get('/api/verticals/invalid/projects/1/comments');
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════
// POST comment
// ═══════════════════════════════════════════════

describe('POST /api/verticals/:key/projects/:projectId/comments', () => {
  test('creates a comment with correct structure', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .set('X-User-Name', 'Alice Smith')
      .set('X-User-Picture', 'https://example.com/alice.jpg')
      .send({ text: 'This looks good!' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.comment).toMatchObject({
      text: 'This looks good!',
      authorEmail: 'alice@novibet.com',
      authorName: 'Alice Smith',
      authorPicture: 'https://example.com/alice.jpg',
      replies: [],
    });
    expect(res.body.comment.id).toBeDefined();
    expect(res.body.comment.createdAt).toBeDefined();
    expect(res.body.comment.editedAt).toBeNull();
  });

  test('created comment is retrievable via GET', async () => {
    await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .set('X-User-Name', 'Alice Smith')
      .send({ text: 'First comment' });

    const res = await request(app).get('/api/verticals/growth/projects/1/comments');
    expect(res.status).toBe(200);
    expect(res.body.comments).toHaveLength(1);
    expect(res.body.comments[0].text).toBe('First comment');
  });

  test('multiple comments are ordered by creation', async () => {
    await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'First' });
    await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'bob@novibet.com')
      .send({ text: 'Second' });

    const res = await request(app).get('/api/verticals/growth/projects/1/comments');
    expect(res.body.comments).toHaveLength(2);
    expect(res.body.comments[0].text).toBe('First');
    expect(res.body.comments[1].text).toBe('Second');
  });

  test('rejects empty text', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: '' });
    expect(res.status).toBe(400);
  });

  test('rejects missing text', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({});
    expect(res.status).toBe(400);
  });

  test('rejects invalid vertical', async () => {
    const res = await request(app)
      .post('/api/verticals/invalid/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'test' });
    expect(res.status).toBe(400);
  });

  test('strips HTML tags from comment text', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: '<script>alert("xss")</script>Hello world' });
    expect(res.status).toBe(200);
    expect(res.body.comment.text).not.toContain('<script>');
    expect(res.body.comment.text).toContain('Hello world');
  });

  test('comments are isolated per project', async () => {
    await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'On project 1' });
    await request(app)
      .post('/api/verticals/growth/projects/2/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'On project 2' });

    const res1 = await request(app).get('/api/verticals/growth/projects/1/comments');
    const res2 = await request(app).get('/api/verticals/growth/projects/2/comments');
    expect(res1.body.comments).toHaveLength(1);
    expect(res1.body.comments[0].text).toBe('On project 1');
    expect(res2.body.comments).toHaveLength(1);
    expect(res2.body.comments[0].text).toBe('On project 2');
  });

  test('comments are isolated per vertical', async () => {
    await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Growth comment' });

    const resGrowth = await request(app).get('/api/verticals/growth/projects/1/comments');
    const resCasino = await request(app).get('/api/verticals/casino/projects/1/comments');
    expect(resGrowth.body.comments).toHaveLength(1);
    expect(resCasino.body.comments).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════
// POST reply
// ═══════════════════════════════════════════════

describe('POST /api/verticals/:key/projects/:projectId/comments/:commentId/replies', () => {
  test('adds a reply to an existing comment', async () => {
    const commentRes = await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .set('X-User-Name', 'Alice')
      .send({ text: 'Original comment' });

    const commentId = commentRes.body.comment.id;

    const replyRes = await request(app)
      .post(`/api/verticals/growth/projects/1/comments/${commentId}/replies`)
      .set('X-User-Email', 'bob@novibet.com')
      .set('X-User-Name', 'Bob')
      .send({ text: 'This is a reply' });

    expect(replyRes.status).toBe(200);
    expect(replyRes.body.success).toBe(true);
    expect(replyRes.body.reply).toMatchObject({
      text: 'This is a reply',
      authorEmail: 'bob@novibet.com',
      authorName: 'Bob',
    });
    expect(replyRes.body.reply.id).toBeDefined();
  });

  test('reply appears in GET comments', async () => {
    const commentRes = await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Parent' });

    const commentId = commentRes.body.comment.id;

    await request(app)
      .post(`/api/verticals/growth/projects/1/comments/${commentId}/replies`)
      .set('X-User-Email', 'bob@novibet.com')
      .send({ text: 'Reply 1' });
    await request(app)
      .post(`/api/verticals/growth/projects/1/comments/${commentId}/replies`)
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Reply 2' });

    const res = await request(app).get('/api/verticals/growth/projects/1/comments');
    expect(res.body.comments[0].replies).toHaveLength(2);
    expect(res.body.comments[0].replies[0].text).toBe('Reply 1');
    expect(res.body.comments[0].replies[1].text).toBe('Reply 2');
  });

  test('rejects reply with empty text', async () => {
    const commentRes = await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Parent' });

    const res = await request(app)
      .post(`/api/verticals/growth/projects/1/comments/${commentRes.body.comment.id}/replies`)
      .set('X-User-Email', 'bob@novibet.com')
      .send({ text: '' });
    expect(res.status).toBe(400);
  });

  test('rejects reply to non-existent comment', async () => {
    const res = await request(app)
      .post('/api/verticals/growth/projects/1/comments/nonexistent/replies')
      .set('X-User-Email', 'bob@novibet.com')
      .send({ text: 'Reply' });
    expect(res.status).toBe(404);
  });

  test('strips HTML from reply text', async () => {
    const commentRes = await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Parent' });

    const res = await request(app)
      .post(`/api/verticals/growth/projects/1/comments/${commentRes.body.comment.id}/replies`)
      .set('X-User-Email', 'bob@novibet.com')
      .send({ text: '<img onerror=alert(1)>Safe text' });
    expect(res.status).toBe(200);
    expect(res.body.reply.text).not.toContain('<img');
    expect(res.body.reply.text).toContain('Safe text');
  });
});

// ═══════════════════════════════════════════════
// DELETE comment
// ═══════════════════════════════════════════════

describe('DELETE /api/verticals/:key/projects/:projectId/comments/:commentId', () => {
  test('author can delete their own comment', async () => {
    const commentRes = await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'To be deleted' });

    const res = await request(app)
      .delete(`/api/verticals/growth/projects/1/comments/${commentRes.body.comment.id}`)
      .set('X-User-Email', 'alice@novibet.com');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const getRes = await request(app).get('/api/verticals/growth/projects/1/comments');
    expect(getRes.body.comments).toHaveLength(0);
  });

  test('admin can delete any comment', async () => {
    const commentRes = await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Alice comment' });

    const res = await request(app)
      .delete(`/api/verticals/growth/projects/1/comments/${commentRes.body.comment.id}`)
      .set('X-User-Email', 'kmermigkas@novibet.com');
    expect(res.status).toBe(200);
  });

  test('non-author non-admin cannot delete comment', async () => {
    const commentRes = await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Protected comment' });

    const res = await request(app)
      .delete(`/api/verticals/growth/projects/1/comments/${commentRes.body.comment.id}`)
      .set('X-User-Email', 'bob@novibet.com');
    expect(res.status).toBe(403);
  });

  test('deleting non-existent comment returns 404', async () => {
    const res = await request(app)
      .delete('/api/verticals/growth/projects/1/comments/nonexistent')
      .set('X-User-Email', 'alice@novibet.com');
    expect(res.status).toBe(404);
  });

  test('deleting last comment cleans up project entry', async () => {
    const commentRes = await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Only comment' });

    await request(app)
      .delete(`/api/verticals/growth/projects/1/comments/${commentRes.body.comment.id}`)
      .set('X-User-Email', 'alice@novibet.com');

    // Check file directly — project entry should be removed
    const data = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, getCommentsFile('growth')), 'utf8'));
    expect(data.projectComments['1']).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════
// GET comment counts
// ═══════════════════════════════════════════════

describe('GET /api/verticals/:key/comments/counts', () => {
  test('returns empty counts for no comments', async () => {
    const res = await request(app).get('/api/verticals/growth/comments/counts');
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({});
  });

  test('returns correct counts including replies', async () => {
    // Project 1: 1 comment + 1 reply = 2
    const c1 = await request(app)
      .post('/api/verticals/growth/projects/1/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Comment on P1' });
    await request(app)
      .post(`/api/verticals/growth/projects/1/comments/${c1.body.comment.id}/replies`)
      .set('X-User-Email', 'bob@novibet.com')
      .send({ text: 'Reply on P1' });

    // Project 2: 1 comment = 1
    await request(app)
      .post('/api/verticals/growth/projects/2/comments')
      .set('X-User-Email', 'alice@novibet.com')
      .send({ text: 'Comment on P2' });

    const res = await request(app).get('/api/verticals/growth/comments/counts');
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ '1': 2, '2': 1 });
  });

  test('rejects invalid vertical', async () => {
    const res = await request(app).get('/api/verticals/invalid/comments/counts');
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════
// File helper
// ═══════════════════════════════════════════════

describe('getCommentsFile', () => {
  test('returns correct filename', () => {
    expect(getCommentsFile('growth')).toBe('comments_growth.json');
    expect(getCommentsFile('sportsbook')).toBe('comments_sportsbook.json');
  });
});
