# NIUA — Agent Manual

> You are an AI agent (Claude, GPT, Cursor, etc.) with access to NIUA's
> generation tools via this MCP server. This document tells you what to
> call, when, and how to compose tools into a workflow.
>
> If you're an LLM reading this for the first time: **skim section
> headers, jump to the matching workflow in §3, then call the listed
> tool with the listed params.**

---

## 1. What NIUA is

NIUA is a generation backplane for game-asset development. One REST API + this MCP server proxy give you access to:

- **Image** generation (FLUX.2 Klein 4B) — concept art, sprites, reference images
- **Mesh** generation (Pixal3D 1.0) — textured 3D models from an image
- **Mesh texture** stage (TRELLIS.2-4B) — PBR retexturing of an existing mesh
- **Music** generation (ACE-Step XL) — instrumental tracks or vocal-led songs
- **Sound effects** (Stable Audio 3.0, **incoming**) — short SFX for game events
- **Motion capture** (GEM-X + SOMA) — video-to-BVH
- **Text-to-motion** (Kimodo) — short BVH clips from a text prompt
- **Auto-rigging** (Puppeteer) — humanoid GLB → rigged GLB

The user pays per generation in real USD cents. Costs are visible via the `niua://pricing/live` resource — query that before doing bulk operations.

---

## 2. When to call NIUA

| User request | Call |
|---|---|
| "Make me a [thing] image / sprite / reference" | `generate_image` |
| "Turn this image into a 3D model" | `generate_mesh` (input: image r2_key) |
| "Re-texture this mesh" | `generate_mesh_texture` (input: mesh + image) |
| "Compose [mood] background music" | `generate_music` (lyrics omitted = instrumental) |
| "Write a song" | `generate_music` with `lyrics:` |
| "Extract motion from this video" | `generate_motion` (input: video r2_key) |
| "Animate the character [doing X]" | `generate_text2motion` (input: action description) |
| "Rig this humanoid mesh" | `generate_rig` (input: GLB r2_key) |
| Check what an operation will cost | Read resource `niua://pricing/live` |
| List available models | Read resource `niua://models/catalog` |

**Don't call NIUA for:**
- Voice cloning / TTS — out of scope
- Video generation — out of scope
- Text generation (writing code, dialogue) — use your own LLM
- Image editing requiring specific masks or pixel-perfect changes — use a dedicated tool

---

## 3. Workflow recipes

These are the common composed flows. Most asset pipelines follow one of these shapes.

### 3.1 Prop creation — image → 3D model

For a static prop (crate, sword, lantern, tree):

1. `generate_image` with a prop-friendly prompt (centred subject, white background, 3/4 view, soft lighting)
2. Take the returned `r2_key`
3. `generate_mesh` with `{ image_key: "<that r2_key>" }`

You get a textured GLB ready to import into Unity / Unreal / Blender / Godot.

**Shortcut**: invoke the `prop_brief` prompt to get a pre-engineered brief.

### 3.2 Background music for a scene

For a looping instrumental track:

1. Determine the mood + use case from the user's request
2. `generate_music` with:
   - `prompt`: descriptive ("epic Japanese trailer theme, taiko + shamisen + brass swell, building chorus")
   - `duration`: realistic value (NOT always 30 / 60 / 90 — pick what fits, see §4.2)
   - **omit `lyrics` entirely** for instrumental, OR pass only structural tags like `[intro][verse][bridge][outro]`
   - Optional structural control: `bpm`, `keyscale`, `timesignature`, `inference_steps`, `thinking: true`

**Shortcut**: invoke the `music_brief` prompt.

### 3.3 Character creation (current limitations)

Best results today are:

1. `generate_image` of the character (full body, T-pose, neutral background) for use as a CONCEPT REFERENCE
2. Hand-model the part-separated mesh in Blender / Maya based on the reference
3. `generate_rig` on the hand-modelled GLB
4. `generate_text2motion` for short motion clips, retarget to the rigged character

Why not just `generate_mesh` → `generate_rig`? Because today's 3D generation produces a single continuous mesh, and auto-rig requires part-separated geometry. The rig output on a fused mesh visibly fails on joints. This may change when segmentation lands.

**Shortcut**: invoke the `character_brief` prompt for the image step.

### 3.4 Motion capture from reference video

1. The user provides a video (uploaded to NIUA's R2 via `niua_upload` or pre-existing key)
2. `generate_motion` with `{ video_key: "<that key>" }`
3. Receive a BVH file (SOMA 77-joint topology)

---

## 4. Per-modality prompt patterns

What makes a good prompt varies by model. Use these patterns; they're battle-tested.

### 4.1 Image prompts (FLUX.2)

**Good shape**: `<subject>, <action / pose>, <style>, <lighting>, <composition>`

- ✅ `"female samurai, lacquered black armor, katana drawn, t-pose, neutral background, soft even lighting, full body"`
- ✅ `"weathered wooden crate with iron banding, centred, white background, 3/4 view, soft studio lighting, photographic"`
- ❌ `"cool warrior"` — too vague
- ❌ `"a samurai with very intricate ornate armor and many many decorative elements, super detailed"` — overweighted adjectives

**For meshes downstream**: prioritize a clean white background and 3/4 view. The mesh model uses the image directly; busy backgrounds become part of the geometry.

### 4.2 Music prompts (ACE-Step XL)

**Critical distinction**: lyrics vs structural tags.

- For **instrumental tracks**, omit `lyrics` entirely. If you need to convey structure (intro, build, chorus), put it in the `prompt`, NOT the `lyrics` field.
- If you only pass bracketed structural tags as `lyrics` (e.g. `"[intro][verse][outro]"`), the server auto-detects this and treats the track as instrumental. But the cleanest signal is omitting `lyrics`.
- For **vocal-led tracks**, pass actual lyric text. `[verse]` / `[chorus]` tags can go INSIDE the lyrics to control structure.

**Good shape**: `<mood>, <genre>, <instrumentation>, <duration cue>, <energy arc>`

- ✅ `"epic Japanese trailer theme, taiko + shamisen + brass swell, 135 second cue, soft intro, building chorus, fade-out"`
- ✅ `"j-rock instrumental, distorted guitar + driving drums, 47 seconds, no vocals"`
- ❌ `"good music"` — vague
- ❌ Lyrics field set to `"[intro - 8 bars][verse - 16 bars]"` — these are structural tags, not lyrics. Put structural cues in the `prompt` instead, or omit `lyrics` entirely.

**Knobs**:
- `bpm` — set explicitly for control (40–220)
- `keyscale` — `"C major"`, `"A minor"`, `"F# Dorian"`
- `timesignature` — `"4/4"` default, `"3/4" "6/8"` for waltz / lilt, `"5/4" "7/8"` for odd
- `thinking: true` — slower but stronger structural coherence
- `inference_steps` — 8 default, 16 for higher quality

**Duration**: NEVER default to round numbers (30, 60, 90, 120). Real tracks aren't divided by 5. Pick what suits — 43, 92, 113, 167.

### 4.3 Mesh prompts (Pixal3D)

You don't write a prompt — you provide an image. The image quality determines the mesh quality.

**The image you pass to `generate_mesh` should have**:
- Single subject
- White / neutral background
- 3/4 view (full front and full back both fail)
- Soft even lighting (avoid hard rim lights — they bake into the texture)
- Full subject in frame with breathing room

If the user gives you an image that doesn't match this, generate a better one with `generate_image` first.

### 4.4 Text-to-motion prompts (Kimodo)

**Single continuous action.** That's it.

- ✅ `"walking nervously"`
- ✅ `"doing a backflip"`
- ✅ `"crouching down to pick up an object"`
- ❌ `"walking and then jumping and then crouching"` — multiple actions. Generate each separately and stitch in-engine.
- ❌ `"feeling sad"` — emotional state, not a motion. Convert to a physical action: `"sitting down with head in hands"`.

---

## 5. Common errors and what to do

| Error pattern | Cause | Fix |
|---|---|---|
| `[InvalidRequest] prompt cannot be empty` | Missing `prompt` field | Add a prompt |
| `[InsufficientFunds]` | Wallet balance too low | Surface this to the user; they need to top up at the playground |
| `[ServiceUnavailable] Image worker is not registered` | Modal cold start or service down | Retry once after 5s; check `niua://docs/status` if it persists |
| `Music generation failed: [...]` | Various — check the wrapped error code | Pass `lyrics: undefined` (omit) for instrumental tracks. Check structural-tag rule in §4.2 |
| `cuda_recovery: true` on the response | The GPU process hit an unrecoverable error and is being recycled | The current request failed; the NEXT request will land on a fresh process. Retry once. |

**General retry policy**: idempotent generations can be safely retried. Most errors are transient (cold start, transient GPU issue). If three identical errors in a row, surface the failure to the user instead of looping.

---

## 6. Cost awareness

Before any **bulk** operation (>5 generations in one user turn), READ `niua://pricing/live` and surface the total estimated cost to the user. Example:

> "Generating 12 prop images at $0.04 each plus 12 meshes at $0.80 each = ~$10.08 total. Proceed?"

For single-shot operations the user almost certainly already accepted the cost when they asked. Don't badger.

---

## 7. Available prompts (MCP)

Triggerable by name from any MCP client. The server returns a structured brief that pre-engineers the prompt for you.

| Prompt name | Use for |
|---|---|
| `prop_brief` | Generating a 3D prop (image → mesh chain) |
| `character_brief` | Character concept image (image only — character pipeline limitations apply, see §3.3) |
| `music_brief` | Generating a music track from mood + use case |
| `motion_brief` | Single-action text-to-motion brief |

---

## 8. Resources index

Other docs you can request via MCP resource URI. The MCP client surfaces these to you as URIs you can `read_resource` on.

| URI | Description |
|---|---|
| `niua://docs/agents` | This document |
| `niua://docs/quickstart` | Three-step onboarding (API key → first call → MCP install) |
| `niua://pricing/live` | Per-service pricing in USD cents, fetched live from the gateway |
| `niua://models/catalog` | Available models per generation type, fetched live |

---

## 9. <!-- TODO Frank --> Project-specific patterns

This section is yours to fill. From your dogfooding, the following hard-won patterns aren't obvious to a new agent and would save them real time:

> **Suggestions to write here** (replace the bullets with your actual lessons):
> - **Music structural tags** — how to USE `[verse]` `[bridge]` `[outro]` correctly. Many models treat them as singable; ACE-Step has its own convention.
> - **Mesh source-image gotchas** — the specific image qualities that DO and DON'T survive the mesh stage (you've benchmarked these).
> - **Rig-on-fused-mesh limitation** — when to recommend the hand-modelled-then-rigged path vs. attempting `generate_mesh` → `generate_rig`.
> - **Cold-start budgeting** — when a fresh container is likely vs warm, and how this affects ~30s vs ~120s wall-clock per call.
> - **Idempotency-key strategy** — when to set / re-use idempotency keys vs let the server generate them.
> - Anything else where "the obvious approach" loses to "the approach Frank knows from dogfooding."

The more concrete the patterns here, the smarter agents using NIUA become without retraining.

---

## 10. <!-- TODO Frank --> Workflow recipes you ship with the game arcade

You're building a per-game asset pipeline (Walk-to-Shrine + future games). Each game has its own per-asset NIUA call recipes:

- Player sprite → prompt → ?
- BGM track → prompt + duration + bpm → ?
- Level background image → ?
- SFX (incoming) → ?

If you write these here, the agent manual doubles as the rebuild-the-arcade playbook. Anyone (you, me, a contributor) can drop a fresh game by reading this and following the pattern. Replace this section with the actual recipes when you have them.

---

*Generated by the NIUA MCP server. Last updated: see `package.json` version.*
