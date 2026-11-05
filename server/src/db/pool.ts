import pg from 'pg';
import { config } from '../config.js';

pg.types.setTypeParser(20, (v) => Number(v)); // int8 -> number (credits/ids fit safely)
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric -> number

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 15 });

export type Q = Pick<pg.PoolClient, 'query'>;

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function one<T = any>(q: Q, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await q.query(sql, params);
  return (r.rows[0] as T) ?? null;
}
export async function many<T = any>(q: Q, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await q.query(sql, params);
  return r.rows as T[];
}
