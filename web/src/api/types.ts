export type Mode = 'simple' | 'detailed';
export type Quality = 'standard' | 'hd';
export type Role = 'product' | 'top' | 'bottom' | 'shoes' | 'bag' | 'accessory' | 'model' | 'style' | 'clone' | 'base';

export interface Me {
  id: string;
  email: string;
  display_name: string | null;
  role: 'user' | 'admin';
  credits: number;
  daily_limit: number | null;
  /** set after an admin password reset; every call except auth & /api/me is refused until changed */
  mustChangePassword?: boolean;
}

export interface Options {
  prices: { standard: number; hd: number };
  ratios: string[];
  tags: string[];
  maxImagesPerJob: number;
}

export interface Project {
  id: string;
  name: string;
  mode: Mode;
  createdAt: string;
  updatedAt: string;
  cover: string | null;
  styleLock?: { jobId: string | null; assetId: string | null; thumb: string | null } | null;
  brand?: Brand | null;
}

export interface Brand { color?: string | null; font?: 'sans' | 'serif' | 'bold' | null; lang?: string | null; note?: string | null }
/** One image of a batch as the user plans it: type + ratio + shot line. */
export interface Row { key: string; tag: string | null; ratio: string; text: string; edited?: boolean }

export interface Upload {
  id: string;
  width: number;
  height: number;
  thumb: string;
  url?: string;
}

export type ItemStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export interface Item {
  id: string;
  jobId: string;
  idx?: number;
  ratio: string;
  status: ItemStatus;
  favorite: boolean;
  quality: Quality | null;
  error: string | null;
  width: number | null;
  height: number | null;
  url: string | null;
  thumb: string | null;
  createdAt?: string;
  /** the file passed the retention period and was deleted */
  expired?: boolean;
  /** ISO time the file will be deleted by retention */
  expiresAt?: string | null;
  qc?: { pass: boolean; retried: boolean; issues?: string[]; fidelity?: boolean } | null;
  layered?: boolean;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed';
export interface Job {
  id: string;
  status: JobStatus;
  quality: Quality;
  prompt: string;
  tags: string[];
  ratios: string[];
  perRatio: number;
  credits: number;
  createdAt: string;
  inputs: JobInput[];
  items: Item[];
  template?: JobTemplate | null;
  kind?: 'generate' | 'retry' | 'edit';
  facts?: Facts | null;
  shots?: Shot[] | null;
  editOp?: EditOp | null;
  editText?: string | null;
  parentItemId?: string | null;
  locked?: boolean;
}

export interface Facts { name: string; points: string[] }
export interface Shot { tag: string | null; text: string }
export type EditOp = 'free' | 'erase' | 'expand' | 'cutout' | 'upscale' | 'recolor' | 'translate' | 'swap_model' | 'pose' | 'text' | 'matte';
export interface Product { id: string; name: string; points: string[]; updatedAt: string; images: Upload[] }

export interface JobInput { assetId: string; role: Role; thumb: string | null; expired?: boolean }

export interface JobPoll {
  id: string;
  status: JobStatus;
  credits: number;
  items: Item[];
}

export interface LedgerRow {
  id?: number;
  delta: number;
  balance_after: number;
  reason: 'invite_grant' | 'reserve' | 'refund' | 'admin_adjust' | string;
  job_id: string | null;
  note?: string | null;
  created_at: string;
}

/* ---------------- model library ---------------- */
export type PortraitSource = 'ai' | 'upload';
export interface Portrait {
  id: string;
  name: string;
  source: PortraitSource;
  attrs: Record<string, string>;
  summary: string;
  portraitAssetId: string;
  createdAt: string;
  url: string | null;
  thumb: string | null;
}
export interface AttrGroup { key: string; label: string; options: { value: string; label: string }[] }
export interface PortraitOptions {
  groups: AttrGroup[];
  defaults: Record<string, string>;
  candidates: number;
  unitPrice: number;
  cost: number;
}
export interface PortraitCandidate { assetId: string; width: number; height: number; url: string | null; thumb: string | null }
export interface PortraitPreview {
  previewId: string;
  charged: number;
  refunded: number;
  credits: number;
  summary: string;
  candidates: PortraitCandidate[];
}

/* ---------------- inspiration templates ---------------- */
export const TEMPLATE_CATEGORIES = ['美妆', '服饰', '食品', '数码', '家居', '珠宝', '节日', '通用'] as const;
export const TEMPLATE_PURPOSES = ['主图', '卖点', '场景', '细节', '氛围', '海报'] as const;
export type TemplatePurpose = (typeof TEMPLATE_PURPOSES)[number];
export interface TemplateField { key: 'brand' | 'headline' | 'sub' | 'points'; label: string; placeholder: string; max: number }
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export interface Template {
  id: string;
  title: string;
  category: TemplateCategory;
  mode: Mode;
  prompt: string;
  tags: string[];
  ratios: string[];
  quality: Quality;
  cover: string | null;
  thumb: string | null;
  descr: string;
  purpose: TemplatePurpose;
  fields: TemplateField[];
  allowText: boolean;
  featured: boolean;
  width: number | null;
  height: number | null;
}
export interface AdminTemplate extends Template {
  sort: number;
  enabled: boolean;
  coverAssetId: string;
  createdAt: string;
  scenePrompt: string;
  source: string;
  uses: number;
}
export interface TemplateUse { template: Template; style: Upload | null }
/** A template a batch was made from (null when none, or the template has been taken down). */
export interface JobTemplate { id: string; title: string; fields: TemplateField[]; values: Record<string, string> }

/* ---------------- admin settings ---------------- */
export interface AdminSettings {
  concurrency_user: number;
  concurrency_global: number;
  beta_default_credits: number;
  beta_daily_image_limit: number;
  mix_batch_enabled: boolean;
  signup_enabled: boolean;
  feature_user_referral: boolean;
  max_images_per_job: number;
  planner_enabled: boolean;
  planner_channel_id: string;
  planner_model: string;
}
export interface ChannelModels { all: string[]; chat: string[]; image: string[] }
