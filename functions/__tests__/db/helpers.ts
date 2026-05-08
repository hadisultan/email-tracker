import postgres, { type Sql, type TransactionSql } from 'postgres';

export const LOCAL_DB_URL =
  process.env.SUPABASE_DB_URL ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export const SEED_USER_ID = '00000000-0000-0000-0000-000000000001';

export type DbExec = Sql | TransactionSql;

export function makeClient(): Sql {
  return postgres(LOCAL_DB_URL, {
    onnotice: () => {},
    fetch_types: false,
    max: 4,
  });
}

export type Role = 'anon' | 'authenticated' | 'service_role';

export async function asRole<T>(
  sql: Sql,
  role: Role,
  userId: string | null,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    if (userId) {
      const claims = JSON.stringify({ sub: userId, role });
      await tx`SELECT set_config('request.jwt.claims', ${claims}, true)`;
    } else {
      await tx`SELECT set_config('request.jwt.claims', '', true)`;
    }
    return fn(tx);
  });
  return result as T;
}

export async function tableExists(sql: DbExec, table: string): Promise<boolean> {
  const rows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return rows[0]!.count === '1';
}

export async function columnNames(sql: DbExec, table: string): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position
  `;
  return rows.map((r) => r.column_name);
}

export async function indexNames(sql: DbExec, table: string): Promise<string[]> {
  const rows = await sql<{ indexname: string }[]>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ${table}
  `;
  return rows.map((r) => r.indexname);
}

export async function fkActions(
  sql: DbExec,
  table: string,
): Promise<Array<{ column: string; references: string; onDelete: string }>> {
  const rows = await sql<
    {
      column_name: string;
      foreign_table: string;
      foreign_column: string;
      on_delete: string;
    }[]
  >`
    SELECT
      kcu.column_name,
      ccu.table_name AS foreign_table,
      ccu.column_name AS foreign_column,
      rc.delete_rule AS on_delete
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.table_schema = tc.table_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
     AND rc.constraint_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = ${table}
  `;
  return rows.map((r) => ({
    column: r.column_name,
    references: `${r.foreign_table}.${r.foreign_column}`,
    onDelete: r.on_delete,
  }));
}
