/**
 * Internal scene template library (never shown to end users).
 *
 * Adapted from "gpt-image2-ecommerce" by Buluu@新西楼 — https://github.com/buluslan/gpt-image2-ecommerce
 * (references/scenarios/*.json scene templates, assets/default-style-lock.json and the Campaign Style Lock protocol).
 * Used under the MIT License:
 *
 *   MIT License — Copyright (c) 2026 Buluu@新西楼
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 *   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 *   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 *   permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *   The above copyright notice and this permission notice shall be included in all copies or substantial portions of
 *   the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
 *   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 *   TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 *
 * Changes: the 39 upstream scenarios were condensed onto Lumi's 8 scene tags (several variants each), rewritten as
 * plain English prompt fragments, typography/icon/text-overlay parts removed (we never render text), and the 10-field
 * Style Lock reduced to the photographic fields (direction, palette, temperature, lighting, presentation).
 */

export type TagKey = 'white_bg' | 'scene' | 'detail' | 'atmosphere' | 'festival' | 'model_wear' | 'flat_lay' | 'street' | 'selling' | 'aplus' | 'angles';
/** Tags whose images may print the customer's own product name / selling points. */
export const TEXT_TAGS: TagKey[] = ['selling', 'aplus'];
export type Category = 'beauty' | 'electronics' | 'food' | 'fashion' | 'home' | 'jewelry' | 'sports' | 'other';
export const CATEGORIES: Category[] = ['beauty', 'electronics', 'food', 'fashion', 'home', 'jewelry', 'sports', 'other'];

export interface SceneVariant { key: string; text: string }
export interface SceneTemplate {
  tag: TagKey;
  /** Upstream scenario ids this tag was built from (for traceability). */
  sources: string[];
  base: string;
  variants: SceneVariant[];
  categoryTips: Partial<Record<Category, string>>;
}

export const SCENES: Record<TagKey, SceneTemplate> = {
  white_bg: {
    tag: 'white_bg',
    sources: ['hero-image', 'transparent-cutout'],
    base: 'Commercial e-commerce packshot on a pure white seamless background (RGB 255,255,255), product centered and filling about 85% of the frame, soft diffused studio lighting with even illumination, a subtle soft contact shadow, no props, marketplace-ready main image.',
    variants: [
      { key: 'front', text: 'Straight front view, perfectly centered, symmetrical framing.' },
      { key: 'three-quarter', text: 'Front three-quarter (3/4) angle that shows depth and side profile, centered.' },
      { key: 'rim', text: 'Softbox overhead with a crisp rim light tracing the edges, product appears to float slightly above the white surface with a faint shadow.' },
      { key: 'high-key', text: 'Bright high-key lighting, very clean edges, slight top-down camera angle.' },
    ],
    categoryTips: {
      beauty: 'emphasize glass/packaging clarity and a gentle glow', electronics: 'highlight metallic finish, screen and port precision',
      food: 'vibrant true colors and fresh appearance', fashion: 'show fabric texture, drape and stitching, garment neatly shaped',
      home: 'show material quality and craftsmanship', jewelry: 'sparkle, cut quality and polished metal reflections',
    },
  },
  scene: {
    tag: 'scene',
    sources: ['lifestyle-scene', 'try-on-virtual'],
    base: 'Editorial lifestyle product photograph: the product placed naturally in a believable real-life setting, the product is the clear focal point, rule-of-thirds composition, tasteful complementary props that never cover the product, shallow depth of field.',
    variants: [
      { key: 'morning', text: 'Bright room with soft morning sunlight streaming through a window, fresh clean mood.' },
      { key: 'cozy', text: 'Warm cozy interior with soft textiles, warm ambient golden light, comfortable intimate mood.' },
      { key: 'outdoor', text: 'Outdoor natural setting with organic elements, golden-hour sunlight, natural and free mood.' },
      { key: 'luxury-interior', text: 'High-end interior with marble surfaces and refined fixtures, cinematic warm grading, premium mood.' },
      { key: 'studio-set', text: 'Styled studio set with a textured backdrop and a plinth, controlled soft lighting, editorial quality.' },
    ],
    categoryTips: {
      beauty: 'bathroom vanity with botanical elements, skincare ritual feel', electronics: 'modern minimal desk setup, in-use context',
      food: 'kitchen counter or dining table with fresh ingredients, warm tones', fashion: 'boutique or urban setting, garment shown fully',
      home: 'styled room interior, product naturally placed', jewelry: 'dressing table with soft fabric, delicate light',
      sports: 'gym or outdoor training context',
    },
  },
  detail: {
    tag: 'detail',
    sources: ['detail-macro'],
    base: 'Macro product photography, extreme close-up of the product showing fine texture, material grain and surface quality, soft directional lighting that rakes across the surface to reveal texture, dedicated macro lens look, ultra sharp focus on the detail area with gentle falloff.',
    variants: [
      { key: 'texture', text: 'Focus on the material surface: grain, weave or finish.' },
      { key: 'craftsmanship', text: 'Focus on stitching, seams, joints, edges and hardware precision.' },
      { key: 'formula', text: 'Focus on the contents or formula (cream, liquid, filling) with light reflections, product still recognisable.' },
      { key: 'functional', text: 'Focus on the key functional part (closure, button, nozzle, sole, port), crisp and well lit.' },
    ],
    categoryTips: {
      beauty: 'cream texture, shimmer particles, light reflection', electronics: 'port precision, material finish, button detail',
      food: 'ingredient texture, cross-section, freshness', fashion: 'fabric weave, stitching quality, hardware detail',
      jewelry: 'gemstone cut, metal finish, clasp detail', home: 'material grain and joinery',
    },
  },
  atmosphere: {
    tag: 'atmosphere',
    sources: ['luxury-atmospherics', 'magazine-editorial', 'creative-concept'],
    base: 'Luxury advertising key visual: the product on a polished reflective surface, cinematic dramatic lighting with a rim light and cool ambient fill, rich mood, atmospheric depth against a dark gradient void, premium campaign photography.',
    variants: [
      { key: 'floral-dream', text: 'Fresh flower petals floating at various heights catching the light, a few gold leaf particles.' },
      { key: 'smoke', text: 'Layered soft smoke swirling around (not covering) the product, deep blue and violet tones.' },
      { key: 'golden-luxe', text: 'Warm amber glow with golden bokeh particles and a few gold flakes.' },
      { key: 'ice-crystal', text: 'Floating ice crystals and frost with diamond-like light refractions, cool platinum spotlight.' },
      { key: 'water-splash', text: 'Dynamic clear water splash frozen in motion behind the product, crisp highlights.' },
    ],
    categoryTips: {
      beauty: 'ethereal glow, subtle condensation, dreamy quality', jewelry: 'diamond-like bokeh on dark ground, sparkle focus',
      food: 'appetizing warm light, steam or droplets', electronics: 'sleek dark stage, light streaks, tech-forward',
      fashion: 'dramatic editorial light on the garment', sports: 'dynamic energy, motion streaks',
    },
  },
  festival: {
    tag: 'festival',
    sources: ['gift-set', 'seasonal-campaign', 'edit-seasonal'],
    base: 'Festive promotional product photograph: warm celebratory gifting atmosphere with tasteful seasonal props arranged around the product, the product stays the dominant focus and is never covered, clean uncluttered composition, no written text or greetings anywhere.',
    variants: [
      { key: 'lunar-new-year', text: 'Lunar New Year: red and gold palette, paper lantern, plum blossom, gold foil accents, warm red festive glow.' },
      { key: 'shopping-festival', text: 'Big shopping festival mood: bright confetti, gift boxes with satin ribbon, energetic but tidy composition.' },
      { key: 'christmas', text: 'Christmas: pine branches, gold ribbon, warm fairy-light bokeh, light snow dusting.' },
      { key: 'valentine', text: "Valentine's: soft pink and red palette, rose petals, velvet ribbon, romantic soft glow." },
      { key: 'mid-autumn', text: 'Mid-Autumn: full-moon glow, osmanthus sprigs, warm lantern light, elegant night-blue and gold palette.' },
    ],
    categoryTips: {
      beauty: 'gift set completeness, limited-edition festive feel', food: 'sharing table, festive packaging',
      jewelry: 'velvet gift box, romantic scene', fashion: 'gift box with ribbon, seasonal styling', home: 'festive decor and warm lighting',
    },
  },
  model_wear: {
    tag: 'model_wear',
    sources: ['model-showcase', 'try-on-virtual', 'magazine-editorial'],
    base: 'Fashion e-commerce photograph of a model wearing the product, full body or three-quarter body, natural relaxed pose that shows the garment completely and clearly, correct fit and drape, realistic skin texture (not retouched), natural anatomy with correct hands and fingers, real camera look (85mm lens). Whenever a person is shown, dress them completely and naturally: if their feet are in frame and no shoes were provided, give them simple plain unbranded shoes that suit the outfit; never barefoot, never half-dressed.',
    variants: [
      { key: 'studio-full', text: 'Clean light-grey studio backdrop, soft beauty-dish lighting, confident direct gaze, full-length.' },
      { key: 'editorial', text: 'Editorial pose with a slight turn, three-quarter body, refined warm-neutral backdrop.' },
      { key: 'candid', text: 'Candid mid-step movement, natural window light, genuine relaxed expression.' },
      { key: 'lifestyle', text: 'Bright minimal interior or boutique setting, natural daylight, lifestyle feel.' },
    ],
    categoryTips: {
      fashion: 'full outfit visible, pose highlights the garment cut', sports: 'active pose, show performance fit',
      jewelry: 'close framing on neck, wrist or hands', beauty: 'close portrait with product near the face',
    },
  },
  flat_lay: {
    tag: 'flat_lay',
    sources: ['flat-lay', 'multi-product'],
    base: 'Flat lay photography, strict top-down overhead view, items neatly arranged with consistent spacing and no overlap, the product as hero, soft natural window light from the top-left at 45 degrees, editorial styling.',
    variants: [
      { key: 'minimal', text: 'Only 2-3 essential complementary items, clean white surface, white and grey palette with one accent colour.' },
      { key: 'linen-luxury', text: 'Ivory linen background with subtle curtain shadow, dried flowers, silk ribbon, champagne-gold accents.' },
      { key: 'outfit-grid', text: 'Coordinated outfit layout (clothing, shoes, accessories) arranged as a balanced grid on a neutral surface.' },
      { key: 'seasonal', text: 'Seasonal props matching the current season, harmonious colour scheme.' },
    ],
    categoryTips: {
      beauty: 'skincare ritual layout with botanical elements', food: 'ingredients spread with kitchen tools',
      fashion: 'clothing, accessories and shoes arranged aesthetically, fabric textures visible', home: 'decor items and materials',
    },
  },
  street: {
    tag: 'street',
    sources: ['ugc-style', 'social-media', 'sports-campaign'],
    base: 'Street-style photograph in an outdoor city environment, natural candid snapshot feel, authentic real-world location, natural daylight, the product clearly visible and in focus, slight background blur. Whenever a person is shown, dress them completely and naturally: if their feet are in frame and no shoes were provided, give them simple plain unbranded shoes that suit the outfit; never barefoot, never half-dressed.',
    variants: [
      { key: 'crosswalk', text: 'Urban crosswalk at golden hour, mid-stride motion, warm low sun.' },
      { key: 'cafe-front', text: 'In front of a stylish cafe storefront, relaxed pose, soft overcast light.' },
      { key: 'social-snap', text: 'Social-media lifestyle snap, slightly off-centre framing, warm film-like colour (Portra 400 feel).' },
      { key: 'alley', text: 'Textured old-town alley with brick or plaster walls, dappled sunlight.' },
    ],
    categoryTips: {
      fashion: 'full look visible, natural walking pose', sports: 'dynamic action on city streets',
      beauty: 'product in hand, natural daylight', electronics: 'product in use on the go',
    },
  },
  selling: {
    tag: 'selling',
    sources: ['selling-points', 'infographic'],
    base: 'Clean e-commerce selling-point image: the product large, sharp and fully visible on a simple premium backdrop, a few short callout labels placed in clean empty areas with thin leader lines pointing to the relevant parts of the product, modern sans-serif typography, generous whitespace, tidy grid alignment, marketplace detail-page quality.',
    variants: [
      { key: 'sides', text: 'Product centred, callouts balanced on the left and right sides.' },
      { key: 'stack', text: 'Product on one side, callouts stacked on the other side with small simple line icons.' },
      { key: 'headline', text: 'A short headline band at the top, product below, callouts around it.' },
    ],
    categoryTips: {
      beauty: 'callouts near ingredients, texture or applicator', electronics: 'callouts at ports, buttons, screen and material',
      food: 'callouts near ingredients and packaging', fashion: 'callouts at fabric, collar, cuffs, pockets and hardware',
      home: 'callouts at material, size and functional parts', jewelry: 'callouts at stone, metal and clasp',
    },
  },
  aplus: {
    tag: 'aplus',
    sources: ['infographic', 'magazine-editorial'],
    base: 'Wide premium brand-content banner for a product detail page (Amazon A+ style module): the product large and sharp on one side, a clean designed backdrop with soft gradient and subtle geometric shapes, a headline area and two to four short feature callouts with small simple line icons placed in calm empty space on the other side, tidy grid alignment, generous whitespace, high-end brand catalogue quality.',
    variants: [
      { key: 'split', text: 'Product on the left third, headline and callouts on the right.' },
      { key: 'hero-band', text: 'Product centred on a stage, headline band above, callouts in a row below.' },
      { key: 'lifestyle-band', text: 'A softly blurred lifestyle setting behind the product, callouts in a translucent panel on the right.' },
    ],
    categoryTips: {
      beauty: 'clean clinical-luxury backdrop, ingredient icons', electronics: 'dark tech gradient, crisp feature icons',
      food: 'fresh ingredient accents, warm appetising palette', fashion: 'fabric close-up inset, editorial palette',
      home: 'room-setting hint, material swatch inset', jewelry: 'velvet and soft sparkle, elegant serif feel',
    },
  },
  angles: {
    tag: 'angles',
    sources: ['hero-image', 'multi-product'],
    base: 'Multi-angle product view: the SAME product shown three times side by side in three equal panels (front view, side view, back view), identical scale and lighting in each panel, uniform light-grey seamless background, thin clean gutters between panels, catalogue-quality packshot lighting.',
    variants: [
      { key: 'front-side-back', text: 'Panels left to right: front, side, back.' },
      { key: 'three-quarter', text: 'Panels: front, three-quarter, top-down.' },
    ],
    categoryTips: {
      fashion: 'garment neatly shaped on an invisible mannequin in every panel', electronics: 'show ports and buttons from each side',
      beauty: 'show label front and back of the bottle', home: 'show proportions and back construction',
    },
  },
};

/** Generic template when the user picked no scene tag. */
export const GENERIC_SCENE = 'Professional commercial e-commerce product photograph, clean composition, the product is the clear focal point, soft natural studio lighting.';

/** Extra camera/composition variations so several images of the same tag differ. */
export const COMPOSITIONS = [
  'eye-level camera', 'slightly elevated camera angle', 'closer medium framing', 'more negative space around the subject',
  'low camera angle', 'gentle side light emphasising texture', 'wider framing', 'warmer colour variant',
];

/** Campaign Style Lock (photographic subset) — shared by every image of one batch so lighting/palette match. */
const LOCK_BASE = {
  visual_direction: 'commercial product photography, consistent across the entire set',
  lighting: 'soft diffused daylight from top-left, gentle falloff, even illumination, subtle rim light on the right edge',
  presentation: 'product sharp throughout, never cropped at the edges, true-to-life colours and proportions',
};
const LOCK_BY_CATEGORY: Record<Category, { palette: string; temperature: string }> = {
  beauty: { palette: 'clean white, soft blush, warm terracotta accent', temperature: 'warm, soft golden ~4500K, gentle glow' },
  electronics: { palette: 'light grey, dark charcoal, electric blue accent', temperature: 'cool blue-white ~6500K, clean precise' },
  food: { palette: 'clean white, warm cream, appetite-red accent', temperature: 'warm golden ~4000K, appetizing' },
  fashion: { palette: 'light grey, neutral beige, warm taupe accent', temperature: 'neutral ~5200K, true-to-fabric' },
  home: { palette: 'warm off-white, beige, warm wood brown accent', temperature: 'warm natural daylight ~5000K, cozy' },
  jewelry: { palette: 'clean white, deep black, metallic gold accent', temperature: 'neutral ~5500K, sparkle-enhancing' },
  sports: { palette: 'light grey, cool grey, energetic orange accent', temperature: 'neutral crisp ~5800K, dynamic' },
  other: { palette: 'white, light grey, charcoal, one restrained accent colour', temperature: 'neutral balanced ~5500K, no strong cast' },
};

export function defaultStyleLock(category: Category = 'other'): string {
  const c = LOCK_BY_CATEGORY[category] ?? LOCK_BY_CATEGORY.other;
  return `Visual direction: ${LOCK_BASE.visual_direction}. Colour palette: ${c.palette}. Colour temperature: ${c.temperature}. ` +
    `Lighting: ${LOCK_BASE.lighting}. Product presentation: ${LOCK_BASE.presentation}.`;
}

export const isTagKey = (t: string): t is TagKey => t in SCENES;

/** Which tag an item gets: tags are spread round-robin over the batch, and items sharing a tag get different variants. */
export function sceneForItem(tags: string[], index: number): { tag: TagKey | null; variant: SceneVariant | null; composition: string } {
  const valid = tags.filter(isTagKey);
  const composition = COMPOSITIONS[index % COMPOSITIONS.length];
  if (!valid.length) return { tag: null, variant: null, composition };
  const tag = valid[index % valid.length];
  const vs = SCENES[tag].variants;
  return { tag, variant: vs[Math.floor(index / valid.length) % vs.length], composition };
}

/**
 * Scene for one item when the user saw/edited a storyboard: the shot's own tag wins; items sharing a tag get
 * successive variants. Falls back to the round-robin above.
 */
export function sceneForShot(tags: string[], index: number, shots?: { tag?: string | null }[] | null) {
  const own = shots?.[index]?.tag;
  if (own && isTagKey(own)) {
    const n = (shots ?? []).slice(0, index).filter((x) => x?.tag === own).length;
    const vs = SCENES[own].variants;
    return { tag: own, variant: vs[n % vs.length], composition: COMPOSITIONS[index % COMPOSITIONS.length] };
  }
  return sceneForItem(tags, index);
}

/** Plain-English scene fragment for one item (used directly when the planner is off, and as planner guidance). */
export function sceneText(tag: TagKey | null, variant: SceneVariant | null, category?: Category): string {
  if (!tag) return GENERIC_SCENE;
  const t = SCENES[tag];
  const tip = category ? t.categoryTips[category] : undefined;
  return [t.base, variant?.text, tip ? `Category tip: ${tip}.` : ''].filter(Boolean).join(' ');
}
