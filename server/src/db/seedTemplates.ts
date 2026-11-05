/**
 * Idempotent starter 灵感模板 seed. Run once:
 *   node --env-file=.env --import tsx src/db/seedTemplates.ts [assetsDir]
 * Images are re-encoded via lib/images and stored as kind 'template' owned by the first admin.
 * Rows are keyed by seed_key, so re-running never duplicates or overwrites admin edits.
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

interface Seed { key: string; file: string; title: string; category: string; mode: 'simple' | 'detailed'; prompt: string; tags: string[]; ratios: string[] }

const SEEDS: Seed[] = [
  { key: 'stone-morning', file: 'r1.jpg', title: '晨光石材', category: '美妆', mode: 'simple', prompt: '放在米色石材台面上，清晨暖光透过窗帘，旁边点缀干花，高级感', tags: ['scene'], ratios: ['1:1', '3:4'] },
  { key: 'silk-herbal', file: 'r2.jpg', title: '丝绸草本', category: '美妆', mode: 'simple', prompt: '平放在奶白色丝绸上，周围点缀绿叶和柠檬片，俯拍，清新自然', tags: ['atmosphere'], ratios: ['1:1'] },
  { key: 'bathroom-green', file: 'r3.jpg', title: '浴室绿植', category: '家居', mode: 'simple', prompt: '放在大理石浴室台面上，旁边有尤加利绿植和叠好的毛巾，柔和自然光', tags: ['scene'], ratios: ['3:4'] },
  { key: 'splash-fresh', file: 'r4.jpg', title: '水花清爽', category: '美妆', mode: 'simple', prompt: '清透水花环绕商品，薄荷绿渐变背景，几片绿叶漂浮，清爽夏日感', tags: ['atmosphere'], ratios: ['1:1', '3:4'] },
  { key: 'hand-hold', file: 'r5.jpg', title: '手持特写', category: '美妆', mode: 'simple', prompt: '一只手自然地拿着商品，米色窗帘做背景，柔光，商品细节清晰', tags: ['detail'], ratios: ['3:4'] },
  { key: 'window-shadow', file: 'reference.jpg', title: '窗台光影', category: '家居', mode: 'simple', prompt: '午后阳光透过窗户投下植物光影，米色墙面与台面，安静高级', tags: ['scene', 'atmosphere'], ratios: ['3:4', '16:9'] },
  { key: 'white-main', file: 'product.jpg', title: '纯白主图', category: '美妆', mode: 'simple', prompt: '纯白背景，商品居中，柔和影棚光，干净的投影', tags: ['white_bg'], ratios: ['1:1'] },
  { key: 'autumn-street', file: 'outfit/c-r1.jpg', title: '秋日街拍', category: '服饰', mode: 'detailed', prompt: '秋天的欧洲石板街头，走路抓拍的感觉，暖金色阳光，自然一点', tags: ['street', 'model_wear'], ratios: ['3:4'] },
  { key: 'brick-lean', file: 'outfit/c-r2.jpg', title: '砖墙暖光', category: '服饰', mode: 'detailed', prompt: '倚靠在复古砖墙边，旁边有街灯和花草，傍晚暖光，松弛自然', tags: ['model_wear'], ratios: ['3:4', '9:16'] },
  { key: 'leaf-flatlay', file: 'outfit/c-r3.jpg', title: '落叶平铺', category: '服饰', mode: 'detailed', prompt: '亚麻布背景上平铺搭配，点缀几片落叶、皮包和皮鞋，俯拍', tags: ['flat_lay'], ratios: ['1:1'] },
  { key: 'knit-detail', file: 'outfit/c-r4.jpg', title: '针织细节', category: '服饰', mode: 'detailed', prompt: '模特半身，双手轻扣纽扣，突出针织纹理，秋日虚化背景', tags: ['detail', 'model_wear'], ratios: ['3:4'] },
  { key: 'autumn-scene', file: 'outfit/c-ref.jpg', title: '秋日街景', category: '服饰', mode: 'detailed', prompt: '金色落叶的石板小巷，复古橱窗暖光，电影感氛围', tags: ['street', 'atmosphere'], ratios: ['3:4', '16:9'] },
];

export async function seedTemplates(assetsDir: string) {
  await migrate();
  const admin = await one<any>(pool, `SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1`);
  if (!admin) throw new Error('no admin user; start the API once (it seeds the admin) and retry');
  let created = 0;
  for (const [i, s] of SEEDS.entries()) {
    if (await one(pool, 'SELECT 1 FROM inspiration_templates WHERE seed_key=$1', [s.key])) continue;
    const path = join(assetsDir, s.file);
    if (!existsSync(path)) { console.warn('missing', path); continue; }
    const img = await sanitizeUpload(await readFile(path));
    const id = randomUUID();
    const key = `templates/${admin.id}/${id}.${img.ext}`;
    await putObject(key, img.data, img.mime);
    await putObject(`thumbs/${admin.id}/${id}.webp`, await thumbnail(img.data), 'image/webp');
    await pool.query(`INSERT INTO assets(id, user_id, kind, storage_key, mime, width, height, bytes, sha256) VALUES ($1,$2,'template',$3,$4,$5,$6,$7,$8)`,
      [id, admin.id, key, img.mime, img.width, img.height, img.data.length, img.sha256]);
    const r = await pool.query(`INSERT INTO inspiration_templates(title, category, mode, cover_asset_id, prompt, tags, ratios, quality, sort, seed_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'standard',$8,$9) ON CONFLICT (seed_key) DO NOTHING`,
      [s.title, s.category, s.mode, id, s.prompt, JSON.stringify(s.tags), JSON.stringify(s.ratios), (i + 1) * 10, s.key]);
    if (r.rowCount) created++;
    else await pool.query('DELETE FROM assets WHERE id=$1', [id]); // lost a race; drop the spare asset row
  }
  console.log(`templates seeded: ${created} new, ${SEEDS.length - created} already present/skipped`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = resolve(process.argv[2] ?? join(here, '../../../../prototype/assets'));
  seedTemplates(dir).then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
