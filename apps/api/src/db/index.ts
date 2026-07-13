import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import dotenv from 'dotenv';
import path from 'path';

// Load env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/convo';

export const pool = new Pool({
  connectionString,
});

export const db = drizzle(pool, { schema });
export type DbType = typeof db;
export * from './schema';
