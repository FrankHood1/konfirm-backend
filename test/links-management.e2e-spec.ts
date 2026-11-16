import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pool } from '../src/db/pool';

// Before this suite existed, a merchant could create a payment link (POST
// /links) but had no route to ever see it again or turn it off — confirmed
// missing by reading links.controller.ts, which had only POST / and
// GET /:id/public. GET /links/mine and POST /links/:id/deactivate close
// that gap; this is their visibility/ownership coverage, same shape as
// payment-visibility.e2e-spec.ts for /payments/mine.
describe('links management: mine + deactivate (e2e)', () => {
  let app: INestApplication;
  const stamp = Date.now();
  const emailA = `links-mgmt-a-${stamp}@example.com`;
  const emailB = `links-mgmt-b-${stamp}@example.com`;
  const addressA = 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB';
  const addressB = 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL';
  let cookieA: string;
  let cookieB: string;
  let linkA: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
    const http = app.getHttpServer();

    const a = await request(http)
      .post('/auth/signup')
      .send({ email: emailA, password: 'correct horse battery', name: 'Links Merchant A', stellar_base_address: addressA })
      .expect(201);
    cookieA = a.headers['set-cookie'][0].split(';')[0];

    const b = await request(http)
      .post('/auth/signup')
      .send({ email: emailB, password: 'correct horse battery', name: 'Links Merchant B', stellar_base_address: addressB })
      .expect(201);
    cookieB = b.headers['set-cookie'][0].split(';')[0];

    const link = await request(http)
      .post('/links')
      .set('Cookie', cookieA)
      .send({ amount_usdc: '10', currency: 'USDC', description: 'links-mgmt fixture' })
      .expect(201);
    linkA = link.body.id;
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM link_sessions WHERE merchant_id IN (SELECT id FROM merchants WHERE email IN ($1, $2))`,
      [emailA, emailB],
    );
    await pool.query(
      `DELETE FROM payments WHERE merchant_id IN (SELECT id FROM merchants WHERE email IN ($1, $2))`,
      [emailA, emailB],
    );
    await pool.query(`DELETE FROM links WHERE merchant_id IN (SELECT id FROM merchants WHERE email IN ($1, $2))`, [
      emailA,
      emailB,
    ]);
    await pool.query('DELETE FROM merchants WHERE email IN ($1, $2)', [emailA, emailB]);
    await app.close();
    await pool.end();
  });

  it('requires a session for both routes', async () => {
    await request(app.getHttpServer()).get('/links/mine').expect(401);
    await request(app.getHttpServer()).post(`/links/${linkA}/deactivate`).expect(401);
  });

  it('shows a merchant their own links and nobody else\'s', async () => {
    const own = await request(app.getHttpServer()).get('/links/mine').set('Cookie', cookieA).expect(200);
    expect(own.body.map((l: { id: string }) => l.id)).toContain(linkA);
    expect(own.body[0]).toHaveProperty('use_count');

    const other = await request(app.getHttpServer()).get('/links/mine').set('Cookie', cookieB).expect(200);
    expect(other.body).toEqual([]);
  });

  it("404s deactivating another merchant's link rather than confirming it exists", async () => {
    await request(app.getHttpServer()).post(`/links/${linkA}/deactivate`).set('Cookie', cookieB).expect(404);

    // Still active afterwards -- merchant B's attempt must be a true no-op.
    const stillActive = await pool.query('SELECT active FROM links WHERE id = $1', [linkA]);
    expect(stillActive.rows[0].active).toBe(true);
  });

  it('404s deactivating a link id that does not exist at all', async () => {
    await request(app.getHttpServer())
      .post('/links/00000000-0000-0000-0000-000000000000/deactivate')
      .set('Cookie', cookieA)
      .expect(404);
  });

  it("deactivates the authenticated merchant's own link, and it stops accepting checkout", async () => {
    const res = await request(app.getHttpServer())
      .post(`/links/${linkA}/deactivate`)
      .set('Cookie', cookieA)
      .expect(200);
    expect(res.body.active).toBe(false);
    expect(res.body.id).toBe(linkA);

    const listed = await request(app.getHttpServer()).get('/links/mine').set('Cookie', cookieA).expect(200);
    expect(listed.body.find((l: { id: string }) => l.id === linkA).active).toBe(false);

    // sessions.service.ts's reserve() checks link.active itself (409
    // 'link is not active') — a deactivated link refuses a brand new
    // checkout before a session even exists, matching the reconciler's own
    // verdict::assess "link_inactive" rule on the chain side.
    await request(app.getHttpServer())
      .post(`/links/${linkA}/sessions`)
      .send({ muxed_id: '555000000000000001' })
      .expect(409);
  });

  it('is idempotent: deactivating an already-inactive link is a no-op 200, not an error', async () => {
    const res = await request(app.getHttpServer())
      .post(`/links/${linkA}/deactivate`)
      .set('Cookie', cookieA)
      .expect(200);
    expect(res.body.active).toBe(false);
  });
});
