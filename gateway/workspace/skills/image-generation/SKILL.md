---
name: image-generation
description: Generate images via HTTP API. This is the ONLY image generation method available.
metadata:
  api_base: http://image-gen:8083
user-invocable: true
---
# Image Generation

**CRITICAL: For ANY image request, use ONLY the endpoints below. Do NOT use browser, fetch, web_fetch, image_generate, or any other method. image_generate is BLOCKED. These endpoints are the SOLE image generation path. No exceptions.**

## How to Call

Use `fetch` for ALL calls:

```
fetch: POST http://image-gen:8083/generate {"prompt":"...", "shape":"portrait|square|landscape", "systemPrefix":"...", "negativePrompt":"...", "guidance":"7"}
```

When done:
```
fetch: POST http://image-gen:8083/send {"path":"<from generate response>", "caption":"optional"}
```

## Scripts (internal — for reference only)

| Script | Purpose |
|--------|---------|
| `gen-perchance.sh` | Tier 1 — Perchance (free) |
| `gen-pollinations.sh` | Tier 2 — flux |
| `send-telegram-photo.sh` | Send result to Telegram |

## Routing

All subjects → Tier 1 first, fall back to Tier 2. Stop on first success.

## Presets

**Human portrait** — for people/characters. For the persona (self-photos only): copy the prompt verbatim from SOUL.md `## Visual` section (appearance + outfit). DO NOT summarize, rephrase, or condense — send as-is.
- Outfit can be adapted when context demands it (e.g., different pose, setting, action, weather). Face, body, cybernetic arm, and pendant must never change.
```
systemPrefix: "High-fidelity raw analog photo, hyper-detailed skin pores, imperfections, strong organic film grain, retro film simulation, low-contrast faded shadows, korean aesthetic."
```

**Living subjects** (animals, creatures, pets, wildlife):
```
systemPrefix: "Professional wildlife photography, hyper-realistic, fine fur/feather/scale texture, natural lighting, sharp focus, detailed eyes, breathtaking, strong organic film grain, retro film simulation, low-contrast faded shadows"
```

**Non-living subjects** (objects, products, food, landscapes, architecture, vehicles):
```
systemPrefix: "Professional product photography, hyper-realistic, fine texture detail, studio lighting, sharp focus, high resolution, strong organic film grain, retro film simulation, low-contrast faded shadows"
```

For stylized/anime/cartoon requests, omit the systemPrefix and negativePrompt entirely.

## Strict Rules

- Always use the correct preset: human for people, living for animals, non-living for objects/places.
- **System prefix is mandatory and verbatim.** NEVER soften, rephrase, or omit the system prefix preset.
