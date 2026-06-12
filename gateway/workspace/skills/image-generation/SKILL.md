---
name: image-generation
description: Generate images via HTTP API. This is the ONLY image generation method available.
user-invocable: true
---
# Image Generation

**CRITICAL: Use ONLY exec: curl to the image-gen service. Do NOT use browser, web_fetch, or bash scripts. image_generate is BLOCKED.**

## How to Generate

```
exec: curl -s -X POST http://image-gen:8083/generate -H "Content-Type: application/json" -d '{"prompt":"PROMPT","shape":"square","systemPrefix":"...","guidance":"7"}'
```

## How to Send Result

```
exec: curl -s -X POST http://image-gen:8083/send -H "Content-Type: application/json" -d '{"path":"OUTPUT_PATH","caption":"optional caption"}'
```

## Presets

**Human portrait** — for people/characters. Self-photos: copy prompt verbatim from SOUL.md `## Visual`.
```
systemPrefix: "High-fidelity raw analog photo, hyper-detailed skin pores, imperfections, strong organic film grain, retro film simulation, low-contrast faded shadows, korean aesthetic."
```
**Living subjects** (animals, creatures):
```
systemPrefix: "Professional wildlife photography, hyper-realistic, fine fur/feather/scale texture, natural lighting, sharp focus, detailed eyes, breathtaking, strong organic film grain, retro film simulation, low-contrast faded shadows"
```
**Non-living subjects** (objects, food, landscapes):
```
systemPrefix: "Professional product photography, hyper-realistic, fine texture detail, studio lighting, sharp focus, high resolution, strong organic film grain, retro film simulation, low-contrast faded shadows"
```

For stylized/anime, omit systemPrefix and negativePrompt.

## Shape options

`portrait` (9:16), `square` (1:1), `landscape` (16:9). Default: `square`.

## Rules

- Tier 1 (Perchance, free) runs automatically. Falls back to Tier 2 (Pollinations/flux).
- Always use the correct preset. System prefix is mandatory and verbatim.
- NEVER use browser, web_fetch, image_generate, or bash scripts. Only exec: curl to image-gen:8083.
- After generation, always call /send to deliver via Telegram.
- `guidance`: 1-20, default 7.
