/**
 * Templates v2 seed (scene templates with hidden scene_prompt, text slots, purpose, featured, source).
 *   node --env-file=.env --import tsx src/db/seedTemplatesV2.ts [dir]     (dev)
 *   node server/dist/db/seedTemplatesV2.js /tmp/templates-v2              (prod container)
 * dir holds templates.json + cover images. Keyed by seed_key: re-running never duplicates or overwrites admin edits.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, one } from './pool.js';
import { migrate } from './migrate.js';
import { sanitizeUpload, thumbnail } from '../lib/images.js';
import { putObject } from '../lib/storage.js';

interface Field { key: string; label: string; placeholder: string; max: number }
interface SeedV2 {
  key: string; file: string; title: string; descr: string; category: string; purpose: string; mode: 'simple' | 'detailed';
  allowText: boolean; fields: Field[]; scene: string; ratios: string[]; featured: boolean; source: string;
}

export async function seedTemplatesV2(dir: string) {
  await migrate();
  const admin = await one<any>(pool, `SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1`);
  if (!admin) throw new Error('no admin user; start the API once (it seeds the admin) and retry');
  const seeds: SeedV2[] = JSON.parse(await readFile(join(dir, 'templates.json'), 'utf8'));
  let created = 0;
  for (const [i, s] of seeds.entries()) {
    const key = `v2-${s.key}`;
    if (await one(pool, 'SELECT 1 FROM inspiration_templates WHERE seed_key=$1', [key])) continue;
    const path = join(dir, s.file);
    if (!existsSync(path)) { console.warn('missing', path); continue; }
    const img = await sanitizeUpload(await readFile(path));
    const id = randomUUID();
    const sk = `templates/${admin.id}/${id}.${img.ext}`;
    await putObject(sk, img.data, img.mime);
    await putObject(`thumbs/${admin.id}/${id}.webp`, await thumbnail(img.data), 'image/webp');
    await pool.query(`INSERT INTO assets(id, user_id, kind, storage_key, mime, width, height, bytes, sha256) VALUES ($1,$2,'template',$3,$4,$5,$6,$7,$8)`,
      [id, admin.id, sk, img.mime, img.width, img.height, img.data.length, img.sha256]);
    const r = await pool.query(`INSERT INTO inspiration_templates(title, category, mode, cover_asset_id, prompt, tags, ratios, quality, sort, seed_key,
        scene_prompt, allow_text, fields, purpose, descr, featured, source)
      VALUES ($1,$2,$3,$4,'', '[]', $5, 'standard', $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (seed_key) DO NOTHING`,
      [s.title, s.category, s.mode, id, JSON.stringify(s.ratios), -1000 + i * 10, key,
        s.scene, s.allowText, JSON.stringify(s.fields), s.purpose, s.descr, s.featured, s.source]);
    if (r.rowCount) created++;
    else await pool.query('DELETE FROM assets WHERE id=$1', [id]);
  }
  console.log(`templates v2 seeded: ${created} new, ${seeds.length - created} already present/skipped`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = resolve(process.argv[2] ?? join(here, '../../seed/templates-v2'));
  seedTemplatesV2(dir).then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
