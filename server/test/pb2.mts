import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { matte } from '../src/services/matting.ts';
const m = await matte(readFileSync('/workspace/projects/34799c8e-8c8f-4178-89e7-3b7003b5a0f1/work/tpl/samples/core-white-main.jpg'));
let mx=0, cnt=0; for (const v of m.alpha) { if (v>mx) mx=v; if (v>=128) cnt++; } console.log(m.width,m.height,mx,cnt, m.alpha.length);
const { data, info } = await sharp(Buffer.from(m.alpha), { raw: { width: m.width, height: m.height, channels: 1 } }).resize(512, 512, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
let c2=0; for (const v of data) if (v>=128) c2++; console.log(info, c2, data.length);
