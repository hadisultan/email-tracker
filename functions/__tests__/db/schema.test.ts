import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SEED_USER_ID,
  asRole,
  columnNames,
  fkActions,
  indexNames,
  makeClient,
  tableExists,
} from './helpers.js';

const sql = makeClient();

beforeAll(async () => {
  await sql`SELECT 1`;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('schema: tables and columns', () => {
  const expected: Record<string, string[]> = {
    users: ['id', 'google_sub', 'email', 'created_at'],
    gmail_credentials: [
      'user_id',
      'refresh_token',
      'access_token',
      'access_token_expires_at',
      'last_history_id',
      'created_at',
      'updated_at',
    ],
    service_tokens: [
      'id',
      'user_id',
      'token_hash',
      'label',
      'created_at',
      'last_used_at',
      'revoked_at',
    ],
    pairing_codes: [
      'code_hash',
      'user_id',
      'created_at',
      'expires_at',
      'consumed_at',
    ],
    messages: [
      'id',
      'user_id',
      'token',
      'client_send_id',
      'subject',
      'recipients',
      'gmail_thread_id',
      'gmail_message_id',
      'sent_at',
      'created_at',
      'last_notified_at',
    ],
    pixel_hits: [
      'id',
      'message_id',
      'hit_at',
      'ip',
      'user_agent',
      'geo',
      'proxy_label',
      'tag',
      'notify_after',
      'notified_at',
    ],
    self_view_beacons: ['id', 'user_id', 'gmail_thread_id', 'received_at'],
    push_subscriptions: [
      'id',
      'user_id',
      'endpoint',
      'p256dh',
      'auth',
      'created_at',
      'last_used_at',
      'last_success_at',
    ],
    gmail_poll_runs: [
      'id',
      'started_at',
      'finished_at',
      'ok',
      'error',
      'history_ids_processed',
      'drained_pushes',
    ],
  };

  for (const [table, cols] of Object.entries(expected)) {
    it(`${table} exists with declared columns`, async () => {
      expect(await tableExists(sql, table)).toBe(true);
      const actual = await columnNames(sql, table);
      for (const c of cols) {
        expect(actual).toContain(c);
      }
    });
  }
});

describe('schema: indexes', () => {
  const expectedIndexes: Record<string, string[]> = {
    pixel_hits: [
      'pixel_hits_message_hit_at_idx',
      'pixel_hits_tag_hit_at_idx',
      'pixel_hits_drain_idx',
    ],
    messages: ['messages_user_sent_at_idx', 'messages_gmail_thread_idx'],
    self_view_beacons: ['self_view_beacons_thread_received_at_idx'],
    push_subscriptions: ['push_subscriptions_user_idx'],
    gmail_poll_runs: ['gmail_poll_runs_ok_finished_idx'],
    service_tokens: ['service_tokens_active_user_idx'],
  };

  for (const [table, idx] of Object.entries(expectedIndexes)) {
    it(`${table} has declared indexes`, async () => {
      const actual = await indexNames(sql, table);
      for (const i of idx) {
        expect(actual).toContain(i);
      }
    });
  }
});

describe('schema: foreign keys cascade on delete', () => {
  const expected: Record<string, string[]> = {
    gmail_credentials: ['user_id'],
    service_tokens: ['user_id'],
    pairing_codes: ['user_id'],
    messages: ['user_id'],
    pixel_hits: ['message_id'],
    self_view_beacons: ['user_id'],
    push_subscriptions: ['user_id'],
  };

  for (const [table, cols] of Object.entries(expected)) {
    it(`${table} FKs declare ON DELETE CASCADE`, async () => {
      const fks = await fkActions(sql, table);
      for (const col of cols) {
        const fk = fks.find((f) => f.column === col);
        expect(fk, `expected FK on ${table}.${col}`).toBeDefined();
        expect(fk!.onDelete).toBe('CASCADE');
      }
    });
  }
});

describe('schema: unique constraints', () => {
  it('messages.client_send_id rejects duplicates', async () => {
    const sendId = '11111111-1111-1111-1111-111111111111';
    await sql`DELETE FROM public.messages WHERE client_send_id = ${sendId}`;
    await sql`
      INSERT INTO public.messages (user_id, client_send_id)
      VALUES (${SEED_USER_ID}, ${sendId})
    `;
    await expect(
      sql`
        INSERT INTO public.messages (user_id, client_send_id)
        VALUES (${SEED_USER_ID}, ${sendId})
      `,
    ).rejects.toThrow(/duplicate key value/);
    await sql`DELETE FROM public.messages WHERE client_send_id = ${sendId}`;
  });
});

describe('schema: tag column accepts arbitrary values (no CHECK constraint)', () => {
  it('pixel_hits.tag accepts an out-of-enum value', async () => {
    const sendId = '22222222-2222-2222-2222-222222222222';
    await sql`DELETE FROM public.messages WHERE client_send_id = ${sendId}`;
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO public.messages (user_id, client_send_id)
      VALUES (${SEED_USER_ID}, ${sendId})
      RETURNING id
    `;
    const messageId = inserted[0]!.id;
    await sql`
      INSERT INTO public.pixel_hits (message_id, tag)
      VALUES (${messageId}, 'invalid')
    `;
    const rows = await sql<{ tag: string }[]>`
      SELECT tag FROM public.pixel_hits WHERE message_id = ${messageId}
    `;
    expect(rows[0]!.tag).toBe('invalid');
    await sql`DELETE FROM public.messages WHERE id = ${messageId}`;
  });
});

describe('schema: drain partial index is used by EXPLAIN', () => {
  it("pixel_hits_drain_idx exists with the right partial predicate, and EXPLAIN picks an index", async () => {
    // Direct schema check: the partial index's WHERE predicate must match
    // the drain query's filter exactly. This is the property we actually
    // care about and it's planner-independent.
    const idxDef = await sql<{ def: string }[]>`
      SELECT pg_get_indexdef(indexrelid) AS def
      FROM pg_index
      WHERE indexrelid = 'public.pixel_hits_drain_idx'::regclass
    `;
    expect(idxDef.length).toBe(1);
    expect(idxDef[0]!.def).toMatch(/WHERE\s+\(\(tag\s*=\s*'none'::text\)\s+AND\s+\(notified_at IS NULL\)\)/i);

    // Planner check: with seqscan + bitmapscan disabled, any index plan
    // is acceptable — both pixel_hits_drain_idx (partial) and
    // pixel_hits_tag_hit_at_idx (composite) are valid for the drain
    // query. The point is "an index is used", not which one.
    const plan = await sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      await tx`SET LOCAL enable_bitmapscan = off`;
      return tx<{ ['QUERY PLAN']: string }[]>`
        EXPLAIN
        SELECT id FROM public.pixel_hits
        WHERE tag = 'none'
          AND notified_at IS NULL
          AND notify_after < now()
      `;
    });
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toMatch(/Index Scan|Index Only Scan/);
  });
});

describe('cascade behavior', () => {
  it('DELETE message cascades to pixel_hits', async () => {
    const sendId = '33333333-3333-3333-3333-333333333333';
    await sql`DELETE FROM public.messages WHERE client_send_id = ${sendId}`;
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO public.messages (user_id, client_send_id)
      VALUES (${SEED_USER_ID}, ${sendId})
      RETURNING id
    `;
    const messageId = inserted[0]!.id;
    await sql`INSERT INTO public.pixel_hits (message_id) VALUES (${messageId})`;
    await sql`INSERT INTO public.pixel_hits (message_id) VALUES (${messageId})`;
    const before = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM public.pixel_hits WHERE message_id = ${messageId}
    `;
    expect(Number(before[0]!.count)).toBe(2);
    await sql`DELETE FROM public.messages WHERE id = ${messageId}`;
    const after = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM public.pixel_hits WHERE message_id = ${messageId}
    `;
    expect(Number(after[0]!.count)).toBe(0);
  });

  it('DELETE user cascades to every child table', async () => {
    const userId = '44444444-4444-4444-4444-444444444444';
    await sql`DELETE FROM public.users WHERE id = ${userId}`;
    await sql`INSERT INTO public.users (id, email) VALUES (${userId}, 'cascade@local.test')`;

    await sql`
      INSERT INTO public.gmail_credentials (user_id)
      VALUES (${userId})
    `;
    await sql`
      INSERT INTO public.service_tokens (user_id, token_hash)
      VALUES (${userId}, 'hash-' || ${userId})
    `;
    await sql`
      INSERT INTO public.pairing_codes (code_hash, user_id, expires_at)
      VALUES ('code-' || ${userId}, ${userId}, now() + interval '10 minutes')
    `;
    const msg = await sql<{ id: string }[]>`
      INSERT INTO public.messages (user_id, client_send_id)
      VALUES (${userId}, gen_random_uuid())
      RETURNING id
    `;
    await sql`INSERT INTO public.pixel_hits (message_id) VALUES (${msg[0]!.id})`;
    await sql`
      INSERT INTO public.self_view_beacons (user_id, gmail_thread_id)
      VALUES (${userId}, 'thread-1')
    `;
    await sql`
      INSERT INTO public.push_subscriptions (user_id, endpoint)
      VALUES (${userId}, 'https://push.example.test/' || ${userId})
    `;

    await sql`DELETE FROM public.users WHERE id = ${userId}`;

    const checks = await Promise.all([
      sql`SELECT COUNT(*)::text AS c FROM public.gmail_credentials WHERE user_id = ${userId}`,
      sql`SELECT COUNT(*)::text AS c FROM public.service_tokens WHERE user_id = ${userId}`,
      sql`SELECT COUNT(*)::text AS c FROM public.pairing_codes WHERE user_id = ${userId}`,
      sql`SELECT COUNT(*)::text AS c FROM public.messages WHERE user_id = ${userId}`,
      sql`SELECT COUNT(*)::text AS c FROM public.pixel_hits WHERE message_id = ${msg[0]!.id}`,
      sql`SELECT COUNT(*)::text AS c FROM public.self_view_beacons WHERE user_id = ${userId}`,
      sql`SELECT COUNT(*)::text AS c FROM public.push_subscriptions WHERE user_id = ${userId}`,
    ]);
    for (const result of checks) {
      const rows = result as unknown as { c: string }[];
      expect(rows[0]!.c).toBe('0');
    }
  });
});

describe('row-level security', () => {
  it('anon SELECT on messages returns zero rows even when data exists', async () => {
    const sendId = '55555555-5555-5555-5555-555555555555';
    await sql`DELETE FROM public.messages WHERE client_send_id = ${sendId}`;
    await sql`
      INSERT INTO public.messages (user_id, client_send_id)
      VALUES (${SEED_USER_ID}, ${sendId})
    `;
    try {
      const rows = await asRole(sql, 'anon', null, async (tx) => {
        return tx<{ id: string }[]>`
          SELECT id FROM public.messages WHERE client_send_id = ${sendId}
        `;
      });
      expect(rows).toHaveLength(0);
    } finally {
      await sql`DELETE FROM public.messages WHERE client_send_id = ${sendId}`;
    }
  });

  it('authenticated user sees only their own messages', async () => {
    const sendId = '66666666-6666-6666-6666-666666666666';
    await sql`DELETE FROM public.messages WHERE client_send_id = ${sendId}`;
    await sql`
      INSERT INTO public.messages (user_id, client_send_id)
      VALUES (${SEED_USER_ID}, ${sendId})
    `;
    try {
      const own = await asRole(sql, 'authenticated', SEED_USER_ID, (tx) =>
        tx<{ id: string }[]>`
          SELECT id FROM public.messages WHERE client_send_id = ${sendId}
        `,
      );
      expect(own).toHaveLength(1);

      const other = await asRole(
        sql,
        'authenticated',
        '99999999-9999-9999-9999-999999999999',
        (tx) =>
          tx<{ id: string }[]>`
            SELECT id FROM public.messages WHERE client_send_id = ${sendId}
          `,
      );
      expect(other).toHaveLength(0);
    } finally {
      await sql`DELETE FROM public.messages WHERE client_send_id = ${sendId}`;
    }
  });

  it('authenticated cannot SELECT gmail_credentials directly', async () => {
    await sql`
      INSERT INTO public.gmail_credentials (user_id, access_token)
      VALUES (${SEED_USER_ID}, 'secret')
      ON CONFLICT (user_id) DO UPDATE SET access_token = EXCLUDED.access_token
    `;
    try {
      const rows = await asRole(sql, 'authenticated', SEED_USER_ID, (tx) =>
        tx<{ access_token: string }[]>`
          SELECT access_token FROM public.gmail_credentials
          WHERE user_id = ${SEED_USER_ID}
        `,
      );
      expect(rows).toHaveLength(0);
    } finally {
      await sql`DELETE FROM public.gmail_credentials WHERE user_id = ${SEED_USER_ID}`;
    }
  });

  it('service_role can SELECT gmail_credentials', async () => {
    await sql`
      INSERT INTO public.gmail_credentials (user_id, access_token)
      VALUES (${SEED_USER_ID}, 'secret')
      ON CONFLICT (user_id) DO UPDATE SET access_token = EXCLUDED.access_token
    `;
    try {
      const rows = await asRole(sql, 'service_role', null, (tx) =>
        tx<{ access_token: string }[]>`
          SELECT access_token FROM public.gmail_credentials
          WHERE user_id = ${SEED_USER_ID}
        `,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.access_token).toBe('secret');
    } finally {
      await sql`DELETE FROM public.gmail_credentials WHERE user_id = ${SEED_USER_ID}`;
    }
  });
});

describe('system_health view', () => {
  it('returns one row for the authenticated owner', async () => {
    const rows = await asRole(sql, 'authenticated', SEED_USER_ID, (tx) =>
      tx<
        {
          user_id: string;
          last_pixel_hit_at: Date | null;
          last_poll_success_at: Date | null;
          oauth_expiry: Date | null;
          last_push_success_at: Date | null;
        }[]
      >`SELECT * FROM public.system_health`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(SEED_USER_ID);
  });

  it('returns zero rows for anon', async () => {
    const rows = await asRole(sql, 'anon', null, (tx) =>
      tx`SELECT * FROM public.system_health`,
    );
    expect(rows).toHaveLength(0);
  });

  it('returns zero rows for an authenticated user with no users-table row', async () => {
    const rows = await asRole(
      sql,
      'authenticated',
      '88888888-8888-8888-8888-888888888888',
      (tx) => tx`SELECT * FROM public.system_health`,
    );
    expect(rows).toHaveLength(0);
  });
});
