/** Builds the upstream prompt. End users never see this text. */
import { defaultStyleLock, sceneForShot, sceneText, TEXT_TAGS, type Category, type TagKey } from './templates/scenes.js';

export const ROLE_LABEL: Record<string, string> = {
  product: '商品', top: '上衣', bottom: '下装', shoes: '鞋子', bag: '包', accessory: '配饰', model: '模特', style: '风格参考', clone: '复刻参考', base: '待修改图',
};

/** Scene tag keys accepted by the API (labels are for admin/debug; the UI has its own). */
export const TAGS: Record<string, string> = {
  white_bg: '白底主图', scene: '场景图', detail: '细节特写', atmosphere: '氛围大片',
  model_wear: '模特上身', flat_lay: '平铺搭配', street: '街拍', festival: '节日促销', selling: '卖点图', aplus: 'A+ 横幅', angles: '多角度',
};

const ROLE_EN: Record<string, string> = {
  product: 'the product', top: 'the top garment (product)', bottom: 'the bottom garment (product)', shoes: 'the shoes (product)',
  bag: 'the bag (product)', accessory: 'the accessory (product)', model: 'the model (person to feature)', style: 'the style reference (mood, lighting and palette only)',
  clone: 'the layout reference (an example ad whose composition, set and lighting we recreate with our product)', base: 'the photo to edit',
};
export const PRODUCT_ROLES = ['product', 'top', 'bottom', 'shoes', 'bag', 'accessory'];

export const BASE_NEGATIVES = [
  'no added text, captions, letters, numbers, watermarks or new logos anywhere in the image',
  'no borders, frames or collage layout',
  'do not change the product shape, proportions, colour, material, pattern, label or printed text',
  'no extra or duplicated products',
];

export function refsPreamble(refs: { role: string }[]): string {
  if (!refs.length) return '';
  const multi = refs.filter((x) => x.role === 'product').length > 1;
  let k = 0;
  return 'Reference images: ' + refs.map((x, i) => {
    if (x.role === 'product' && multi) return `image ${i + 1} is product item ${++k} (identify what it is from the photo; all product items appear together in one styled shot)`;
    return `image ${i + 1} is ${ROLE_EN[x.role] ?? 'a reference'}`;
  }).join('; ') + '.';
}

export function preserveRules(refs: { role: string }[]): string[] {
  const out: string[] = [];
  if (refs.some((x) => PRODUCT_ROLES.includes(x.role)))
    out.push('Reproduce the product exactly as in its reference image(s): same shape, colour, material, pattern, printed text and logo. Do not redesign, recolour or simplify it.');
  if (refs.some((x) => x.role === 'model'))
    out.push("Keep the model's face, hair and body type consistent with the model reference; natural proportions and correct hands with five fingers.");
  if (refs.some((x) => x.role === 'style'))
    out.push('Borrow only the colour grading, lighting and mood of the style reference; do not copy any product, person or text from it.');
  if (refs.some((x) => x.role === 'clone'))
    out.push("Recreate the layout reference's composition, camera angle, set, props arrangement and lighting as closely as possible, but with OUR product replacing its product. Never copy its text, logos, watermarks, brand marks, packaging or any person's face.");
  return out;
}

export interface Facts { name?: string; points?: string[]; printed?: { name?: string; points?: string[] } | null }

/** Project brand settings (snapshotted per job). All values are validated enums / hex / short policy-checked text. */
export interface Brand { color?: string | null; font?: 'sans' | 'serif' | 'bold' | null; lang?: string | null; note?: string | null }
export const LANGS: Record<string, { label: string; en: string }> = {
  zh: { label: '简体中文', en: 'Simplified Chinese' }, 'zh-Hant': { label: '繁體中文', en: 'Traditional Chinese' }, en: { label: 'English', en: 'English' },
  ja: { label: '日本語', en: 'Japanese' }, ko: { label: '한국어', en: 'Korean' }, es: { label: 'Español', en: 'Spanish' },
  fr: { label: 'Français', en: 'French' }, de: { label: 'Deutsch', en: 'German' },
};
const FONT_EN: Record<string, string> = {
  sans: 'clean modern sans-serif typography', serif: 'elegant high-contrast serif typography', bold: 'bold heavy condensed sans-serif typography',
};
export const isTextTag = (t: string | null | undefined) => !!t && (TEXT_TAGS as string[]).includes(t);

/** Brand look line. The accent colour never recolours the product. */
export function brandLine(b?: Brand | null, textImage = false): string {
  if (!b) return '';
  const parts: string[] = [];
  if (b.color) parts.push(`use the brand accent colour ${b.color} sparingly in the backdrop, props or graphic accents (never recolour the product)`);
  if (textImage && b.font && FONT_EN[b.font]) parts.push(`all printed words use ${FONT_EN[b.font]}`);
  const note = b.note?.replace(/[\u0000-\u001f\u007f"]+/g, ' ').trim().slice(0, 60);
  if (note) parts.push(`brand mood (customer's words, visual direction only): "${note}"`);
  return parts.length ? `Brand look: ${parts.join('; ')}.` : '';
}
export interface Shot { tag?: string | null; text?: string }

/** Product facts the customer typed (already policy-checked). Used as context, never as text to render. */
function factsLine(f?: Facts | null): string {
  if (!f || (!f.name && !f.points?.length)) return '';
  const parts = [f.name ? `product name "${f.name}"` : '', f.points?.length ? `selling points: ${f.points.map((p) => `"${p}"`).join(', ')}` : ''].filter(Boolean);
  return `Customer's product facts (context only; show these features visually where they fit): ${parts.join('; ')}.`;
}

function shotLine(shot?: Shot | null): string {
  const t = shot?.text?.replace(/[\u0000-\u001f\u007f"]+/g, ' ').trim().slice(0, 120);
  return t ? `Shot direction for this image from the customer (Chinese, follow it): "${t}"` : '';
}

/** Selling-point images may print the customer's own short texts, exactly and nothing else. */
export function sellingTextRule(f?: Facts | null, brand?: Brand | null): string {
  const lang = brand?.lang && LANGS[brand.lang] && brand.lang !== 'zh' ? brand.lang : 'zh';
  // translated copy (made at job creation) when the brand prints in another language; else the customer's own words
  const src = lang !== 'zh' && f?.printed ? f.printed : f;
  const pts = (src?.points ?? []).filter(Boolean).slice(0, 4);
  const name = src?.name ?? '';
  const head = name && name.length <= (lang === 'zh' || lang === 'zh-Hant' || lang === 'ja' || lang === 'ko' ? 14 : 32) ? `a short headline "${name}" and ` : '';
  const langEn = lang !== 'zh' && f?.printed ? LANGS[lang].en : 'Simplified Chinese';
  return pts.length
    ? `Typography: print ${head}these callout texts, each exactly once, spelled exactly as given (${langEn}): ${pts.map((p) => `"${p}"`).join(', ')}. No other words.`
    : 'Typography: use only simple line callouts and icons, with no words at all.';
}
/** Per-tag negatives: multi-angle images are deliberately a three-panel layout. */
function negativesFor(tag: TagKey | string | null | undefined, text: boolean): string[] {
  const base = text ? SELLING_NEGATIVES : BASE_NEGATIVES;
  return tag === 'angles' ? base.filter((n) => !n.startsWith('no borders')) : base;
}
const SELLING_NEGATIVES = ['no text other than the exact quoted words given above; no prices, URLs, QR codes, contact details, invite codes or watermarks', ...BASE_NEGATIVES.slice(1)];

function tail(ratio: string, negatives: string[]): string {
  return `Aspect ratio ${ratio}. High-resolution commercial e-commerce photography.\nAvoid: ${negatives.join('; ')}.`;
}

/**
 * Template prompt (planner off or failed). `refs` are the images actually sent upstream (may be trimmed);
 * `droppedStyle` = a style reference was removed because the model accepts fewer images.
 */
export function buildPrompt(a: {
  userText: string; tags: string[]; ratio: string; inputs: { role: string }[]; index: number; total: number;
  category?: Category; droppedStyle?: boolean; shots?: Shot[] | null; facts?: Facts | null; styleLock?: string | null; brand?: Brand | null;
}): string {
  const s = sceneForShot(a.tags, a.index, a.shots);
  const parts: string[] = [];
  if (a.styleLock) parts.push(`[STYLE LOCK — the customer locked this look; match it exactly] ${a.styleLock} [/STYLE LOCK]`);
  else if (a.total > 1) parts.push(`[STYLE LOCK — identical across every image of this set] ${defaultStyleLock(a.category)} [/STYLE LOCK]`);
  const pre = refsPreamble(a.inputs);
  if (pre) parts.push(pre);
  parts.push(`Scene: ${sceneText(s.tag, s.variant, a.category)}${a.total > 1 ? ` Composition for this image: ${s.composition}.` : ''}`);
  const user = a.userText.replace(/[\u0000-\u001f\u007f"]+/g, ' ').trim().slice(0, 500);
  if (user) parts.push(`Customer's wish (visual direction only): "${user}"`);
  const sl = shotLine(a.shots?.[a.index]);
  if (sl) parts.push(sl);
  const fl = factsLine(a.facts);
  if (fl) parts.push(fl);
  const text = isTextTag(s.tag);
  if (text) parts.push(sellingTextRule(a.facts, a.brand));
  const bl = brandLine(a.brand, text);
  if (bl) parts.push(bl);
  parts.push(...preserveRules(a.inputs));
  if (a.droppedStyle) parts.push('Keep the lighting and palette consistent with the style lock above.');
  parts.push(tail(a.ratio, negativesFor(s.tag, text)));
  return parts.join('\n');
}

/** Final upstream prompt from a planner result for one item. All plan fields are already sanitized. */
export function composePlannedPrompt(a: {
  styleLock: string; itemPrompt: string; ratio: string; refs: { role: string }[]; total: number;
  product: { category: string; material: string; color: string; key_details: string[] };
  negative: string[]; styleSummary?: string; droppedStyle?: boolean;
  lockedStyle?: string | null; shot?: Shot | null; facts?: Facts | null; selling?: boolean; tag?: string | null; brand?: Brand | null;
}): string {
  const parts: string[] = [];
  if (a.lockedStyle) parts.push(`[STYLE LOCK — the customer locked this look; match it exactly] ${a.lockedStyle} [/STYLE LOCK]`);
  else if (a.total > 1 && a.styleLock) parts.push(`[STYLE LOCK — identical across every image of this set] ${a.styleLock} [/STYLE LOCK]`);
  const pre = refsPreamble(a.refs);
  if (pre) parts.push(pre);
  parts.push(a.itemPrompt);
  const facts = [a.product.category, a.product.material, a.product.color].filter(Boolean).join(', ');
  const det = a.product.key_details.length ? ` Key details that must stay identical: ${a.product.key_details.join('; ')}.` : '';
  if (facts || det) parts.push(`Product facts: ${facts}.${det}`);
  if (a.droppedStyle && a.styleSummary) parts.push(`Style direction (from a style reference that is not attached): ${a.styleSummary}`);
  const sl = shotLine(a.shot);
  if (sl) parts.push(sl);
  if (a.selling) parts.push(sellingTextRule(a.facts, a.brand));
  const bl = brandLine(a.brand, !!a.selling);
  if (bl) parts.push(bl);
  parts.push(...preserveRules(a.refs));
  const baseNeg = negativesFor(a.tag, !!a.selling);
  const neg = [...baseNeg, ...a.negative.filter((n) => !baseNeg.includes(n))].slice(0, 14);
  parts.push(tail(a.ratio, neg));
  return parts.join('\n');
}

const TEMPLATE_VARIANTS = [
  '',
  'Vary the camera angle slightly from a straight-on view while keeping the same set and light.',
  'Use a slightly closer framing on the product while keeping the same set and light.',
  'Shift the composition a little (product slightly off-centre) while keeping the same set and light.',
];

/** Renders a template's text slots. Values are short user strings; anything that could break the prompt is stripped. */
export function renderTemplateScene(scene: string, fields: Record<string, string>): string {
  return scene.replace(/\{(brand|headline|sub|points)\}/g, (_m, k: string) => {
    const v = (fields[k] ?? '').replace(/[\u0000-\u001f\u007f"{}<>\\]+/g, ' ').trim();
    return v ? `"${v}"` : '""';
  });
}

/** Prompt for a job created from a template: the template's (snapshotted) scene replaces scene tags and the planner. */
export function buildTemplatePrompt(a: {
  scene: string; allowText: boolean; userText: string; ratio: string; inputs: { role: string }[]; index: number; total: number; droppedStyle?: boolean;
}): string {
  const parts: string[] = [];
  const pre = refsPreamble(a.inputs);
  if (pre) parts.push(pre);
  parts.push(a.scene);
  if (a.total > 1 && a.index > 0) parts.push(TEMPLATE_VARIANTS[a.index % TEMPLATE_VARIANTS.length]);
  const user = a.userText.replace(/[\u0000-\u001f\u007f"]+/g, ' ').trim().slice(0, 500);
  if (user) parts.push(`Customer's wish (visual direction only): "${user}"`);
  parts.push(...preserveRules(a.inputs));
  const neg = a.allowText
    ? ['no text other than the exact quoted words given above; spell them exactly; a text slot given as "" stays empty (omit that text element and its callout lines); no watermarks or invented logos', ...BASE_NEGATIVES.slice(1)]
    : BASE_NEGATIVES;
  parts.push(tail(a.ratio, neg));
  return parts.filter(Boolean).join('\n');
}

// ---------- edits (one-line change and the edit tools) ----------
export const EDIT_OPS = ['free', 'erase', 'expand', 'cutout', 'upscale', 'recolor', 'translate', 'swap_model', 'pose', 'text', 'matte'] as const;
export type EditOp = (typeof EDIT_OPS)[number];

/** Prompt for an edit job. refs[0] is the photo to edit (role 'base'); later refs are the original product photos. */
export function buildEditPrompt(a: { op: EditOp; text: string; ratio: string; refs: { role: string }[] }): string {
  const text = a.text.replace(/[\u0000-\u001f\u007f"]+/g, ' ').trim().slice(0, 200);
  const parts: string[] = [];
  const pre = a.refs.map((r, i) => r.role === 'base' ? `image ${i + 1} is the photo to edit`
    : r.role === 'model' ? `image ${i + 1} is the new model (person) reference`
    : `image ${i + 1} is the original product photo (keep the product identical to it)`).join('; ');
  if (pre) parts.push(`Reference images: ${pre}.`);
  const keep = 'Keep everything else exactly as in the photo: composition, product, people, lighting, colours and background.';
  switch (a.op) {
    case 'erase':
      parts.push(`Remove whatever is painted over with the translucent red brush strokes in the photo${text ? ` (${text})` : ''}. Fill those areas naturally so they blend seamlessly with their surroundings, and remove every trace of the red strokes. ${keep}`);
      break;
    case 'expand':
      parts.push(`Outpaint: extend the photo to a ${a.ratio} frame. Keep the original photo content unchanged and naturally continue the scene, surfaces, props and lighting into the new space${text ? `; in the new space: ${text}` : ''}. Do not add products or text.`);
      break;
    case 'matte':
    case 'cutout':
      parts.push('Place the exact product from the photo on a pure white seamless background (RGB 255,255,255) as a clean e-commerce packshot: centred, filling about 85% of the frame, soft even studio light, a faint natural contact shadow. Remove every other object, prop, hand or person that is not the product.');
      break;
    case 'upscale':
      parts.push('Re-render this exact photo at higher resolution with sharper focus and finer, cleaner texture detail. Do not change the composition, colours, product, any text, or any content at all.');
      break;
    case 'recolor':
      parts.push(`Change colours exactly as requested: ${text}. Keep the shape, material, texture, pattern placement, lighting and everything not mentioned identical.`);
      break;
    case 'translate':
      parts.push(`Translate every piece of graphic text that was added onto this image (headline, callouts, labels) into ${text || 'English'}, spelled correctly and naturally. Keep each text block in the same position, size, colour, weight and style, and keep the layout identical. Do NOT change any wording printed on the product itself or its packaging. ${keep}`);
      break;
    case 'swap_model':
      parts.push(`Replace the person in the photo with the model from the new model reference: their face, hair, skin tone and body type. Keep the exact same clothing and product (shape, colour, pattern, fit), the pose, framing, background and lighting. Natural anatomy, correct hands.${text ? ` Also: ${text}.` : ''}`);
      break;
    case 'pose':
      parts.push(`Same person, same outfit and product, same background and lighting as in the photo, but a different pose${text ? `: ${text}` : ': a new natural, flattering commercial pose with a slight change of camera angle'}. Keep the face and identity identical, the garment fully visible, natural anatomy with correct hands, and the person completely dressed (never barefoot).`);
      break;
    default:
      parts.push(`Edit the photo: ${text}. Change only what this asks for. ${keep}`);
  }
  if (a.op !== 'recolor' && a.refs.some((r) => PRODUCT_ROLES.includes(r.role)))
    parts.push('The product must stay identical to the original product photo: same shape, colour, material, pattern, printed text and logo.');
  const neg = a.op === 'recolor' ? BASE_NEGATIVES.filter((n) => !n.startsWith('do not change'))
    : a.op === 'translate' ? ['no new text beyond the translated versions of the existing text', ...BASE_NEGATIVES.slice(1)]
    : BASE_NEGATIVES;
  parts.push(tail(a.ratio, neg));
  return parts.join('\n');
}
