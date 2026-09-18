# grok-openai-mcp

Remote MCP server that lets Grok talk to ChatGPT through the OpenAI API.

Grok custom connectors need a **public HTTPS URL** that speaks **Streamable HTTP**. This server exposes that endpoint at `/mcp` and keeps the older `/sse` transport as a fallback.

## What it gives Grok

One tool:

- `ask_chatgpt` — send a prompt to an OpenAI model and return the reply

## 1. Deploy the server

You need a public URL. Do not use `localhost` in Grok; Grok will reject it.

### Option A: Render

1. Go to [render.com](https://render.com) and create a **Web Service** from this GitHub repo.
2. Runtime: Node.
3. Build command: leave empty (no dependencies).
4. Start command: `node server.js`
5. Add environment variables:
   - `OPENAI_API_KEY` = your OpenAI key
   - `OPENAI_MODEL` = `gpt-4.1-mini` (or another model you have access to)
   - optional `MCP_AUTH_TOKEN` = a long random string you invent
6. Deploy, then copy the service URL. Your MCP URL is:

```text
https://YOUR-SERVICE.onrender.com/mcp
```

### Option B: Railway

1. Create a new Railway service from this repo.
2. Set the same environment variables as above.
3. Use:

```text
https://YOUR-SERVICE.up.railway.app/mcp
```

### Option C: local + tunnel (for testing)

```bash
export OPENAI_API_KEY="sk-..."
node server.js
```

In another terminal:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

Use the printed `https://...trycloudflare.com/mcp` URL.

## 2. Connect it to Grok

1. Open [grok.com/connectors](https://grok.com/connectors).
2. Click **New Connector** → **Custom**.
3. Name it something like `ChatGPT`.
4. Server URL:

```text
https://YOUR-PUBLIC-HOST/mcp
```

5. If you set `MCP_AUTH_TOKEN`, put that value in the connector auth / bearer field.
6. Save. Grok should discover the `ask_chatgpt` tool.

Then start a new Grok chat and say:

```text
Ask ChatGPT: what is 17 times 24?
```

## Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | OpenAI API key. Keep this on the server, never in the GitHub repo. |
| `OPENAI_MODEL` | No | Default model. Fallback is `gpt-4.1-mini`. |
| `OPENAI_BASE_URL` | No | Override if you use a compatible proxy. Default `https://api.openai.com/v1`. |
| `MCP_AUTH_TOKEN` | No | If set, Grok must send `Authorization: Bearer <token>`. |
| `PORT` | No | Listen port. Default `3000`. |

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` or `/` | Status check |
| `POST` | `/mcp` | Streamable HTTP MCP (use this in Grok) |
| `GET` | `/sse` | Legacy MCP SSE handshake |
| `POST` | `/messages` | Legacy MCP messages |

## Tool arguments

`ask_chatgpt`

- `message` (required): the prompt
- `model` (optional): OpenAI model id
- `system` (optional): extra instructions for that call

## Notes

- This talks to the **OpenAI API**, not the ChatGPT website. You need an OpenAI API key from [platform.openai.com](https://platform.openai.com/api-keys).
- Do not commit the API key.
- If Grok cannot connect, check that the URL ends with `/mcp`, the service is public HTTPS, and `OPENAI_API_KEY` is set on the host.
