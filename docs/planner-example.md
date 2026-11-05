# Planner — status & example (2026-10-28)

## Current status: planner NOT configured (template prompts)

The planner LLM will be a **separate upstream** connected later (an OpenAI-compatible **vision chat** model on a
channel with `purpose: 'chat'`). The grok2api / gptchat2api relays are for image generation only and must not be
used as the planner. Settings in dev: `planner_enabled=true, planner_channel_id='', planner_model=''` → planner skipped.

To enable later (admin):
1. `POST /api/admin/channels {name, vendor:'openai_compat', purpose:'chat', baseUrl, apiKey}`
2. `GET /api/admin/channels/:id/models` → pick a vision-capable id from `chat`
3. `PUT /api/admin/settings {planner_channel_id:'<id>', planner_model:'<model>'}`

## Real run with planner skipped (2026-10-28)

Job `27403746-…` — simple mode, inputs product.jpg (`product`) + reference.jpg (`style`), prompt
「放在原木桌面上，清晨窗边自然光，干净高级」, tags `scene, detail`, ratios `1:1, 3:4`, standard.

- `jobs.plan` = `NULL` (planner skipped, no planner call logged)
- both items succeeded (1:1 on Grok, 3:4 on GPT via mix-batch); `upstream_call_logs.note` = `prompt=template` for both
- credits: invite 100 → reserve −4 (2 × 2) → balance 96, no refunds

Template prompt actually sent for item 0 (from `buildPrompt`):

```
[STYLE LOCK — identical across every image of this set] Visual direction: commercial product photography, consistent across the entire set. Colour palette: white, light grey, charcoal, one restrained accent colour. Colour temperature: neutral balanced ~5500K, no strong cast. Lighting: soft diffused daylight from top-left, gentle falloff, even illumination, subtle rim light on the right edge. Product presentation: product sharp throughout, never cropped at the edges, true-to-life colours and proportions. [/STYLE LOCK]
Reference images: image 1 is the product; image 2 is the style reference (mood, lighting and palette only).
Scene: Editorial lifestyle product photograph: the product placed naturally in a believable real-life setting, … Bright room with soft morning sunlight streaming through a window, fresh clean mood. Composition for this image: eye-level camera.
Customer's wish (visual direction only): "放在原木桌面上，清晨窗边自然光，干净高级"
Reproduce the product exactly as in its reference image(s): same shape, colour, material, pattern, printed text and logo. …
Borrow only the colour grading, lighting and mood of the style reference; do not copy any product, person or text from it.
Aspect ratio 1:1. High-resolution commercial e-commerce photography.
Avoid: no added text, captions, letters, numbers, watermarks or new logos anywhere in the image; …
```

## Shape of `jobs.plan` once a planner is connected

**Illustrative only — not output from a real run** (no planner model has been connected yet). Schema: `planSchema`
in `server/src/services/planner.ts`; strings are sanitized to plain text and length-capped.

```json
{
  "v": 1, "status": "ok", "model": "<planner_model>", "ms": 6400, "at": "2026-…Z",
  "plan": {
    "verdict": "ok", "block_reason": "",
    "product": { "category": "beauty", "name": "glass serum bottle with dropper", "material": "frosted glass, rubber bulb",
                 "color": "amber glass, black cap", "key_details": ["label text exactly as in the reference", "…"] },
    "style_lock": "Soft morning window light from the left, warm-neutral palette of oak, cream and amber …",
    "style_reference_summary": "Sunlit windowsill, plant shadows on a beige wall, calm minimal mood …",
    "negative": ["label warped", "cap colour changed"],
    "items": [ { "index": 0, "prompt": "The product stands on a light oak table near a window …" },
               { "index": 1, "prompt": "Close-up detail of the product's dropper and label …" } ]
  }
}
```

`status` can also be `blocked` (items fail with `content_blocked`, refunded) or `failed` (template prompt used).
