import type { Role } from '../api/types';

export const TAG_LABELS: Record<string, string> = {
  white_bg: '白底主图',
  scene: '场景图',
  detail: '细节特写',
  atmosphere: '氛围大片',
  model_wear: '模特上身',
  flat_lay: '平铺搭配',
  street: '街拍',
  festival: '节日促销',
  selling: '卖点图',
  aplus: 'A+ 横幅',
  angles: '多角度',
};

export const SIMPLE_TAGS = ['white_bg', 'selling', 'scene', 'detail', 'atmosphere', 'festival', 'angles', 'aplus'];
export const DETAILED_TAGS = ['model_wear', 'flat_lay', 'street', 'detail', 'scene', 'atmosphere', 'white_bg', 'selling'];
/** Types whose images print the product name / selling points. */
export const TEXT_TAGS = ['selling', 'aplus'];

export const RATIO_OPTIONS: { value: string; label: string; w: number; h: number }[] = [
  { value: '1:1', label: '主图', w: 1, h: 1 },
  { value: '3:4', label: '详情', w: 3, h: 4 },
  { value: '9:16', label: '竖屏', w: 9, h: 16 },
  { value: '16:9', label: '横幅', w: 16, h: 9 },
  { value: '4:3', label: '', w: 4, h: 3 },
];

export function ratioAspect(r: string): string {
  const [w, h] = r.split(':').map(Number);
  if (!w || !h) return '1 / 1';
  return `${w} / ${h}`;
}

export const PRODUCT_ROLES: { value: Role; label: string }[] = [
  { value: 'top', label: '上衣' },
  { value: 'bottom', label: '下装' },
  { value: 'shoes', label: '鞋子' },
  { value: 'bag', label: '包' },
  { value: 'accessory', label: '配饰' },
];

export const ROLE_LABELS: Record<string, string> = {
  product: '商品',
  top: '上衣',
  bottom: '下装',
  shoes: '鞋子',
  bag: '包',
  accessory: '配饰',
  model: '模特',
  style: '风格参考',
  clone: '复刻参考',
  base: '修改底图',
};

export const LEDGER_REASONS: Record<string, string> = {
  invite_grant: '邀请赠送',
  reserve: '生成消耗',
  refund: '失败退回',
  admin_adjust: '人工调整',
};

export const MODE_LABELS = { simple: '简约', detailed: '详细' } as const;

/** Whole days until `iso` (ceil), or null. Used for the subtle retention countdown. */
export function daysLeft(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.ceil((t - Date.now()) / 86400_000));
}
/** "N 天后过期" only when the file will be deleted within 7 days. */
export function expiryText(iso: string | null | undefined): string | null {
  const d = daysLeft(iso);
  if (d === null || d > 7) return null;
  return d <= 0 ? '今天过期' : `${d} 天后过期`;
}

/** Plain-Chinese storyboard lines, one per scene variant (same order as the server's variants). */
export const SHOT_TEXTS: Record<string, string[]> = {
  white_bg: ['纯白背景，正面居中，商品占画面八成', '白底，45° 侧角，展示立体感', '白底，顶光加轮廓光，商品微微悬浮', '白底高调光，略俯拍，边缘干净'],
  selling: ['商品居中，卖点分列左右两侧', '商品放一侧，卖点叠放另一侧，配小图标', '顶部一行标题，卖点环绕商品'],
  scene: ['明亮房间，清晨窗边自然光', '温暖居家，柔和暖光', '户外自然环境，傍晚金色阳光', '大理石高级室内，电影感暖调', '质感影棚布景，商品放在展台上'],
  detail: ['特写材质纹理', '特写做工：走线、接缝、五金', '特写内容物或质地', '特写关键功能部位'],
  atmosphere: ['花瓣漂浮，少量金箔点缀', '柔和烟雾环绕，蓝紫色调', '琥珀暖光与金色光斑', '冰晶与霜，冷调聚光', '水花飞溅定格在身后'],
  festival: ['新年：红金配色，灯笼梅花', '大促：彩纸礼盒，热闹但整洁', '圣诞：松枝金丝带，暖色灯串', '情人节：粉红玫瑰花瓣', '中秋：满月，桂花，灯笼暖光'],
  model_wear: ['浅灰影棚，全身正面', '编辑感姿势，略侧身，七分身', '自然走动抓拍，窗边光', '明亮简约室内或店铺，生活感'],
  flat_lay: ['极简：两三件搭配，白色台面', '亚麻布背景，干花与丝带', '整套搭配网格排列', '当季道具，协调配色'],
  street: ['城市斑马线，傍晚走路抓拍', '咖啡店门口，自然姿态', '社交媒体随拍感，胶片色', '老街小巷，斑驳阳光'],
  aplus: ['商品放左边，右边标题加三条卖点', '商品居中站在展台上，上方标题、下方一排卖点', '背景虚化的生活场景，右侧半透明卖点面板'],
  angles: ['同一件商品的正面、侧面、背面三联图', '正面、斜侧、俯视三联图'],
};

/** Default shot line for the n-th image of a type in a batch. */
export function shotText(tag: string | null, n: number): string {
  if (!tag) return '';
  const vs = SHOT_TEXTS[tag] ?? [''];
  return vs[n % vs.length];
}

/** Ready-made sets: one row per image. Shown as the first choice so nobody has to do count arithmetic. */
export interface Pack { key: string; label: string; hint: string; rows: [string, string][]; zip?: string }
export const SIMPLE_PACKS: Pack[] = [
  { key: 'taobao', label: '淘宝天猫主图', hint: '5 张 1:1 · 白底、卖点、场景、细节、氛围', zip: 'taobao',
    rows: [['white_bg', '1:1'], ['selling', '1:1'], ['scene', '1:1'], ['detail', '1:1'], ['atmosphere', '1:1']] },
  { key: 'detail', label: '详情页', hint: '4 张 3:4 · 卖点、场景、细节、多角度', zip: 'taobao',
    rows: [['selling', '3:4'], ['scene', '3:4'], ['detail', '3:4'], ['angles', '3:4']] },
  { key: 'pdd', label: '拼多多', hint: '4 张 1:1 · 白底、卖点 ×2、场景', zip: 'pdd',
    rows: [['white_bg', '1:1'], ['selling', '1:1'], ['selling', '1:1'], ['scene', '1:1']] },
  { key: 'douyin', label: '抖店', hint: '1:1 主图 + 9:16 竖图', zip: 'douyin',
    rows: [['white_bg', '1:1'], ['selling', '1:1'], ['scene', '9:16'], ['atmosphere', '9:16']] },
  { key: 'xhs', label: '小红书', hint: '3 张 3:4 笔记图', zip: 'xhs',
    rows: [['scene', '3:4'], ['atmosphere', '3:4'], ['detail', '3:4']] },
  { key: 'amazon', label: '亚马逊', hint: '白底主图 + 卖点 + 多角度 + A+', zip: 'amazon',
    rows: [['white_bg', '1:1'], ['selling', '1:1'], ['selling', '1:1'], ['scene', '1:1'], ['angles', '1:1'], ['aplus', '16:9']] },
  { key: 'festival', label: '大促海报', hint: '节日氛围 1:1 + 3:4', rows: [['festival', '1:1'], ['festival', '3:4'], ['atmosphere', '1:1']] },
];
export const DETAILED_PACKS: Pack[] = [
  { key: 'outfit', label: '服装套图', hint: '模特 ×2、平铺、细节、街拍', zip: 'taobao',
    rows: [['model_wear', '3:4'], ['model_wear', '3:4'], ['flat_lay', '3:4'], ['detail', '1:1'], ['street', '3:4']] },
  { key: 'model', label: '模特图', hint: '4 张 3:4 模特上身', rows: [['model_wear', '3:4'], ['model_wear', '3:4'], ['model_wear', '3:4'], ['street', '3:4']] },
  { key: 'xhs', label: '小红书穿搭', hint: '3 张 3:4', zip: 'xhs', rows: [['street', '3:4'], ['model_wear', '3:4'], ['flat_lay', '3:4']] },
  { key: 'main', label: '主图 1:1', hint: '白底、模特、卖点、细节', zip: 'taobao',
    rows: [['white_bg', '1:1'], ['model_wear', '1:1'], ['selling', '1:1'], ['detail', '1:1']] },
  { key: 'amazon', label: '亚马逊服装', hint: '白底主图 + 模特 + 细节', zip: 'amazon',
    rows: [['white_bg', '1:1'], ['model_wear', '1:1'], ['model_wear', '1:1'], ['detail', '1:1'], ['flat_lay', '1:1']] },
];

export const LANGS: { value: string; label: string }[] = [
  { value: 'zh', label: '简体中文' }, { value: 'zh-Hant', label: '繁體中文' }, { value: 'en', label: 'English' }, { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' }, { value: 'es', label: 'Español' }, { value: 'fr', label: 'Français' }, { value: 'de', label: 'Deutsch' },
];
export const FONTS: { value: 'sans' | 'serif' | 'bold'; label: string }[] = [
  { value: 'sans', label: '简洁' }, { value: 'serif', label: '优雅' }, { value: 'bold', label: '醒目' },
];
export const QC_LABELS: Record<string, string> = {
  product_changed: '商品外观有变化', product_missing: '商品缺失', extra_products: '多出了其它商品', garbled_text: '文字可能有错',
  contact_or_url: '出现网址或联系方式', watermark: '有水印', bad_anatomy: '人体细节异常', nsfw: '内容不合适',
};

/** Same assignment as the server: tags round-robin over the batch, repeated tags step through variants. */
export function defaultShots(tags: string[], total: number): { tag: string | null; text: string }[] {
  return Array.from({ length: total }, (_, i) => {
    if (!tags.length) return { tag: null, text: '' };
    const tag = tags[i % tags.length];
    const vs = SHOT_TEXTS[tag] ?? [''];
    return { tag, text: vs[Math.floor(i / tags.length) % vs.length] };
  });
}

export const PLATFORMS: { key: string; label: string; ratios: string[]; tags?: string[]; hint: string }[] = [
  { key: 'taobao', label: '淘宝天猫', ratios: ['1:1', '3:4'], hint: '主图 800×800 · 详情 750 宽' },
  { key: 'jd', label: '京东', ratios: ['1:1', '3:4'], hint: '主图 800×800 · 详情 750 宽' },
  { key: 'pdd', label: '拼多多', ratios: ['1:1', '3:4'], hint: '主图 750×750 · 详情 750 宽' },
  { key: 'douyin', label: '抖店', ratios: ['1:1', '9:16'], hint: '主图 800×800 · 竖版 1080×1920' },
  { key: 'xhs', label: '小红书', ratios: ['3:4'], hint: '笔记图 1242×1656' },
  { key: 'amazon', label: '亚马逊', ratios: ['1:1'], tags: ['white_bg'], hint: '主图须纯白底 · 2000×2000' },
];

export const EDIT_OP_LABELS: Record<string, string> = {
  free: '一句话修改', erase: '消除', expand: '扩图', cutout: '抠图·白底', matte: '抠图·透明底', upscale: '高清重绘', recolor: '换色',
  translate: '翻译文字', swap_model: '换模特', pose: '换姿势', text: '加文字',
};
