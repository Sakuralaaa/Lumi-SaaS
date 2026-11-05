import { fileURLToPath } from 'node:url';
import { pool, one } from './pool.js';
import { config } from '../config.js';
import { hashPassword } from '../auth.js';
import { changeCredits } from '../services/credits.js';
import { tx } from './pool.js';

/** Idempotent: inserts defaults only when missing; never overwrites admin edits. */
export async function seed() {
  await pool.query(`INSERT INTO pricing(quality, credits) VALUES ('standard',2),('hd',4) ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO platform_models(key, display_name) VALUES ('grok','Grok Imagine 2.0'),('gpt','GPT Image 2.5') ON CONFLICT DO NOTHING`);
  const hasRules = await one(pool, 'SELECT 1 FROM routing_rules LIMIT 1');
  if (!hasRules) {
    const rules = [
      ['参考图 4 张以上 → GPT', 10, { min_refs: 4 }, 'gpt', 'grok'],
      ['高清 2K → Grok', 20, { quality: 'hd' }, 'grok', 'gpt'],
      ['氛围类场景 → GPT', 30, { tags_any: ['atmosphere', 'festival'] }, 'gpt', 'grok'],
      ['默认 → Grok', 100, {}, 'grok', 'gpt'],
    ];
    for (const [name, pr, match, p, f] of rules) {
      await pool.query('INSERT INTO routing_rules(name, priority, match, primary_model, fallback_model) VALUES ($1,$2,$3,$4,$5)', [name, pr, JSON.stringify(match), p, f]);
    }
  }
  if (config.ADMIN_EMAIL && config.ADMIN_PASSWORD) {
    const exists = await one(pool, 'SELECT 1 FROM users WHERE email=$1', [config.ADMIN_EMAIL.toLowerCase()]);
    if (!exists) {
      await tx(async (c) => {
        const u = await one<any>(c, `INSERT INTO users(email, password_hash, role, display_name) VALUES ($1,$2,'admin','管理员') RETURNING id`,
          [config.ADMIN_EMAIL!.toLowerCase(), await hashPassword(config.ADMIN_PASSWORD!)]);
        await changeCredits(c, { userId: u.id, delta: 1000, reason: 'admin_adjust', note: 'seed' });
      });
      console.log('admin user created');
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seed().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
