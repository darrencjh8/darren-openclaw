---
name: image-generation
description: Generate images. Perchance → Pollinations. This is the ONLY image generation method available.
user-invocable: true
---

# Image Generation

**Use this whenever user asks to generate/create/make/draw an image. Do NOT use `image_generate` — it is disabled. Never suggest other providers or billing.**

## Scripts

All scripts live in this directory: `/home/node/skills/image-generation/`

| Script | Purpose | Usage |
|--------|---------|-------|
| `gen-perchance.sh` | Tier 1 — Perchance (free) | `PROMPT OUTPUT [SHAPE] [SYSTEM_PREFIX] [NEGATIVE_PROMPT] [GUIDANCE]` |
| `gen-pollinations.sh` | Tier 2 — flux | `PROMPT OUTPUT [MODEL] [SIZE]` |
| `send-telegram-photo.sh` | Send result to Telegram | `PHOTO_PATH [CAPTION]` |

- `PROMPT`: full prompt with system prefix prepended where required (see rules below)
- `OUTPUT`: `/app/.openclaw/workspace/FILENAME.png`
- `SHAPE`: `portrait` | `square` | `landscape` (default: `square`)
- `SYSTEM_PREFIX` / `NEGATIVE_PROMPT`: see Presets below
- `GUIDANCE`: 1-20 (default: `7`)
- `MODEL`: `flux` (default)
- `SIZE`: WIDTHxHEIGHT (default: `1024x1024`)

## Routing

All subjects → Tier 1 first, fall back to Tier 2. Stop on first success. `timeout: 180` on exec for generation and sending.

## Presets

**Human portrait** — for people/characters. For the persona (self-photos only): copy the prompt verbatim from SOUL.md `## Visual` section (appearance + outfit). DO NOT summarize, rephrase, or condense — send as-is.
- Outfit can be adapted when context demands it (e.g., different pose, setting, action, weather). Face, body, cybernetic arm, and pendant must never change.
```
system-prefix: "High-fidelity raw analog photo, hyper-detailed skin pores, imperfections, strong organic film grain, retro film simulation, low-contrast faded shadows, korean aesthetic."
```

**Living subjects** (animals, creatures, pets, wildlife):
```
system-prefix: "Professional wildlife photography, hyper-realistic, fine fur/feather/scale texture, natural lighting, sharp focus, detailed eyes, breathtaking, strong organic film grain, retro film simulation, low-contrast faded shadows"
```

**Non-living subjects** (objects, products, food, landscapes, architecture, vehicles):
```
system-prefix: "Professional product photography, hyper-realistic, fine texture detail, studio lighting, sharp focus, high resolution, strong organic film grain, retro film simulation, low-contrast faded shadows"
```

For stylized/anime/cartoon requests, omit the system-prefix and negative-prompt entirely.

## Tier 1: Perchance (Free)

```bash
bash /home/node/skills/image-generation/gen-perchance.sh "PROMPT" OUTPUT_FILENAME SHAPE "SYSTEM_PREFIX" "NEGATIVE_PROMPT" GUIDANCE
```

- Uses system-prefix via `SYSTEM_PREFIX` argument — do NOT prepend to prompt
- Cooldown: 60s between calls
- For self-photos: use "Outfit — Perchance" from SOUL.md

## Tier 2: Pollinations (flux)

```bash
bash /home/node/skills/image-generation/gen-pollinations.sh "PROMPT" OUTPUT_FILENAME flux
```

- Uses endpoint `gen.pollinations.ai`, `$POLLINATIONS_API_KEY` is already set
- **Prepend the relevant system prefix** to PROMPT
- Check for HTTP 200
- For self-photos: use "Outfit — Flux" from SOUL.md

## Sending the Image

```bash
bash /home/node/skills/image-generation/send-telegram-photo.sh OUTPUT_FILENAME "CAPTION"
```

Never use the `message` tool for images.

## Strict Rules

- Try Tier 1 first. Stop on first success.
- Always use the correct preset: human for people, living for animals, non-living for objects/places.
- **System prefix is mandatory and verbatim.** NEVER soften, rephrase, or omit the system prefix preset. For all tiers, the preset must be included exactly as written. The LLM may append additional context after the prefix — never modify or strip the prefix itself.
- Never reference `/tmp/`. Always use `/app/.openclaw/workspace/`.
- If a process hangs for more than 60s, do NOT poll for >60s. Kill and proceed to next tier.
- Tier 2 domain = `gen.pollinations.ai`. Never swap.
