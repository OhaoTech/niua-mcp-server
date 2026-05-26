# NIUA MCP Server

Generate game assets directly from Claude Desktop, Cursor, Cline, or any
MCP-compatible client. Tools call the NIUA HTTP API with your API key
and save results to your working directory.

Built against the [MCP 2025-11-25 spec](https://modelcontextprotocol.io/specification/2025-11-25),
using `@modelcontextprotocol/sdk` 1.29.

## Setup

### 1. Get an API key

Sign in at [niua.ohao.tech](https://niua.ohao.tech) → **Settings →
Developer → Create API Key**. Copy the `niua_live_…` token.

### 2. Wire up the MCP server

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "niua": {
      "command": "npx",
      "args": ["-y", "github:OhaoTech/niua-mcp-server"],
      "env": { "NIUA_API_KEY": "niua_live_your_key_here" }
    }
  }
}
```

**Cursor / Cline** — add the same block to that client's MCP server
config. Restart the client.

Alternative auth: run `npx -y github:OhaoTech/niua-mcp-server --login` once for a
browser-based device-auth flow (like `gh auth login`). The key is
saved to `~/.niua/credentials.json` and picked up automatically — no
need to set `NIUA_API_KEY`.

### 3. Use it

In your client, ask:

```
Generate a low-poly sword reference image and save it as sword.png,
then turn it into a 3D mesh.
```

```
Generate a 60-second epic battle track and save it as battle.wav.
```

```
Use the prop_brief prompt to scaffold a weathered crate.
```

## Tools

| Tool | What it does |
|------|--------------|
| `generate_image` | Text prompt → PNG image |
| `generate_music` | Text prompt (optional lyrics) → WAV audio |
| `generate_mesh` | Image → textured 3D mesh (GLB with PBR materials), one call |
| `generate_mesh_texture` | Re-texture an existing GLB conditioned on a new reference image |
| `generate_motion` | Video → BVH motion capture (async — returns `job_id`, poll with `get_job`) |
| `generate_text2motion` | Text prompt → BVH animation |
| `generate_rig` | Auto-rig a **user-authored** part-separated GLB (Blender / Maya / Sketchfab exports). Not designed for `generate_mesh` output — see note below. |
| `get_job` | Look up an async job by id; downloads the asset when it lands |
| `check_balance` | Wallet balance and live per-service pricing |

All calls are charged from your wallet in real USD cents. Run
`check_balance` to see the current prices — they are not hardcoded
into this README, so you always get the live number from the API.

### Long-running tools and progress

`generate_mesh`, `generate_mesh_texture`, and `generate_rig` block on
synchronous HTTP for several minutes. When your MCP client sets a
`progressToken` in the request `_meta`, the server emits a
`notifications/progress` event every 30 seconds with elapsed time, so
the client UI can show "still working" instead of opaque silence.

### Note on rigging generated meshes

`generate_rig` is designed for part-separated geometry: meshes you
authored in Blender, exported from Maya, or downloaded from
Sketchfab. The output of `generate_mesh` is a single continuous
surface, which is fine for static props but produces visibly
degraded results when an auto-rigger tries to bind a skeleton to it.

The chained character composite (image → mesh → rig) was retired
from the API for this reason. Use `generate_mesh` on its own for
static assets, and `generate_rig` on its own for characters you
bring in part-separated.

## Resources

Read-only references your agent can fetch without invoking a tool
(and without charging the wallet):

| URI | What it returns |
|-----|-----------------|
| `niua://docs/quickstart` | Three-step onboarding (Markdown) |
| `niua://pricing/live` | Per-service pricing, fetched live from `/api/billing/prices` |
| `niua://models/catalog` | Available models per generation type, live from `/api/v1/models` |

## Prompts

Canned brief templates that walk you through composing a good
generation prompt for each modality:

| Prompt | Use it for |
|--------|------------|
| `prop_brief` | Compose a `generate_image` → `generate_mesh` brief for a static 3D prop |
| `character_brief` | Compose a character concept image brief (stops at the image stage) |
| `music_brief` | Compose a `generate_music` brief with mood, use case, duration |
| `motion_brief` | Compose a `generate_text2motion` brief — single continuous action |

## Uploads

When you pass `image_path` / `video_path` to a tool, the file is
uploaded with the gateway's presigned-R2 flow:

1. Ask the gateway for a signed PUT URL.
2. PUT the bytes directly to R2.
3. Tell the gateway the upload landed.

This keeps your file off the gateway transit path. Per-type size
caps apply (image 10 MB, audio 50 MB, model 100 MB, video 500 MB,
BVH 10 MB), with a 5 GB per-user quota.

## Configuration

| Env Var | Description | Default |
|---------|-------------|---------|
| `NIUA_API_KEY` | Your API key (required if not using `--login`) | — |
| `NIUA_API_URL` | Custom API URL (e.g. for staging) | `https://api.niua.ohao.tech` |

Credentials saved by `--login` live at `~/.niua/credentials.json`
(mode 0600 on Unix).

## Development

### Test locally with MCP Inspector

The official [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)
is the recommended dev loop — it talks to your local build and lets
you exercise tools, resources, and prompts interactively without
needing a host client.

```bash
# Build the server
npm run build

# Point Inspector at your local build (NIUA_API_KEY pre-loaded from env)
NIUA_API_KEY=niua_live_… npx @modelcontextprotocol/inspector node dist/index.js
```

The Inspector UI surfaces structured logs from the server (every
tool call writes a `[niua-mcp] event=… tool=…` line to stderr), so
you can verify the right call is firing with the right arguments.

### Logging

Tool calls log to stderr in a grep-able key=value format:

```
[niua-mcp] event=ready version="0.5.0" api_url="https://api.niua.ohao.tech"
[niua-mcp] event=tool_call tool="generate_image" width=1024 height=1024
[niua-mcp] event=tool_ok tool="generate_image" ms=8421
```

Host clients (Claude Desktop, Cursor) show these in their server
logs panel.

### Errors

Tool failures return `isError: true` so clients can distinguish
"tool returned an error message" from "tool ran successfully."
Gateway error envelopes are parsed into `[code] message` form —
e.g. `[insufficient_funds] Wallet balance below cost (49¢)`.

## License

MIT — [ohao.tech](https://ohao.tech)
