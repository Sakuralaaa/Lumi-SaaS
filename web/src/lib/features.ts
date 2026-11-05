import type { Mode } from '../api/types';

export const FEATURES: { key: string; title: string; desc: string; mode: Mode; tag: string; a: string; b: string }[] = [
  { key: 'scene', title: '场景图', desc: '白底商品，放进真实的生活场景', mode: 'simple', tag: 'scene', a: 'feat-scene-a', b: 'feat-scene-b' },
  { key: 'mood', title: '氛围大片', desc: '水花、光影、质感，一张顶一组', mode: 'simple', tag: 'atmosphere', a: 'feat-mood-a', b: 'feat-mood-b' },
  { key: 'model', title: '模特上身', desc: '衣服直接穿到模特身上', mode: 'detailed', tag: 'model_wear', a: 'feat-model-a', b: 'feat-model-b' },
  { key: 'flat', title: '平铺搭配', desc: '几件单品，搭成一张平铺图', mode: 'detailed', tag: 'flat_lay', a: 'feat-flat-a', b: 'feat-flat-b' },
];
