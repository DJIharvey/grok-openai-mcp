const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || process.env.BEARER_TOKEN || "";
const SERVER_NAME = "grok-openai-mcp";
const SERVER_VERSION = "1.1.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-03-26", "2024-11-05"];

const sessions = new Map();

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
    ...extra
  };
}

function sendJSON(res, status, data, extraHeaders = {}) {
  res.writeHead(status, corsHeaders({
    "Content-Type": "application/json",
    ...extraHeaders
  }));
  res.end(JSON.stringify(data));
}

function sendAccepted(res) {
  res.writeHead(202, corsHeaders());
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function pathnameOf(req) {
  try {
    return new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "/";
  }
}

function queryOf(req) {
  try {
    return new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return new URL("http://localhost/");
  }
}

function extractBearer(req) {
  const header = req.headers.authorization || "";
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const url = queryOf(req);
  return url.searchParams.get("token") || "";
}

function isAuthorized(req) {
  if (!MCP_AUTH_TOKEN) return true;
  return extractBearer(req) === MCP_AUTH_TOKEN;
}

function extractOpenAIText(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  const parts = [];
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (!item) continue;
      if (typeof item.text === "string") parts.push(item.text);
      if (Array.isArray(item.content)) {
        for (const content of item.content) {
          if (!content) continue;
          if (typeof content.text === "string") parts.push(content.text);
          if (typeof content.refusal === "string") parts.push(content.refusal);
        }
      }
    }
  }

  if (Array.isArray(data.choices)) {
    for (const choice of data.choices) {
      const message = choice && choice.message;
      if (message && typeof message.content === "string") parts.push(message.content);
    }
  }

  return parts.filter(Boolean).join("\n").trim();
}

async function askOpenAI({ message, model, system }) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured on the MCP server.");
  }
  if (!message || !String(message).trim()) {
    throw new Error("A message is required.");
  }

  const input = [];
  if (system && String(system).trim()) {
    input.push({ role: "system", content: String(system) });
  }
  input.push({ role: "user", content: String(message) });

  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: model || OPENAI_MODEL,
      input
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI API request failed with status ${response.status}.`);
  }

  const text = extractOpenAIText(data);
  if (!text) {
    throw new Error("OpenAI returned an empty response.");
  }
  return text;
}

function toolList() {
  return {
    tools: [
      {
        name: "ask_chatgpt",
        description: "Send a question or request to ChatGPT via the OpenAI API and return its reply.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The question or request to send to ChatGPT."
            },
            model: {
              type: "string",
              description: "Optional OpenAI model id. Defaults to the server OPENAI_MODEL."
            },
            system: {
              type: "string",
              description: "Optional system instructions for this request."
            }
          },
          required: ["message"]
        }
      }
    ]
  };
}

async function handleJsonRpc(request) {
  if (!request || typeof request !== "object") {
    return {
      errorResponse: {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      }
    };
  }

  const { id, method, params } = request;

  if (!method) {
    return {
      errorResponse: {
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: -32600, message: "Invalid request" }
      }
    };
  }

  if (typeof method === "string" && method.startsWith("notifications/")) {
    return { notification: true };
  }

  if (method === "initialize") {
    const requested = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : "2025-03-26";

    return {
      response: {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false }
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION
          },
          instructions: "Use ask_chatgpt to send a prompt to ChatGPT through the OpenAI API."
        }
      }
    };
  }

  if (method === "ping") {
    return { response: { jsonrpc: "2.0", id, result: {} } };
  }

  if (method === "tools/list") {
    return { response: { jsonrpc: "2.0", id, result: toolList() } };
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name !== "ask_chatgpt") {
      return {
        response: {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: `Unknown tool: ${name || "(missing)"}` }]
          }
        }
      };
    }

    try {
      const answer = await askOpenAI({
        message: args.message,
        model: args.model,
        system: args.system
      });
      return {
        response: {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: answer }]
          }
        }
      };
    } catch (error) {
      return {
        response: {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: error.message }]
          }
        }
      };
    }
  }

  if (method === "resources/list") {
    return { response: { jsonrpc: "2.0", id, result: { resources: [] } } };
  }

  if (method === "prompts/list") {
    return { response: { jsonrpc: "2.0", id, result: { prompts: [] } } };
  }

  return {
    errorResponse: {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code: -32601, message: `Method not found: ${method}` }
    }
  };
}

async function handleMcpPost(req, res) {
  const raw = await readBody(req);
  let request;
  try {
    request = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJSON(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" }
    });
  }

  const handled = await handleJsonRpc(request);
  if (handled.notification) {
    return sendAccepted(res);
  }
  if (handled.errorResponse) {
    return sendJSON(res, 200, handled.errorResponse);
  }
  return sendJSON(res, 200, handled.response);
}

function startLegacySse(req, res) {
  const sessionId = crypto.randomUUID();
  res.writeHead(200, corsHeaders({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  }));
  sessions.set(sessionId, res);
  res.write("event: endpoint\n");
  res.write(`data: /messages?sessionId=${sessionId}\n\n`);
  req.on("close", () => sessions.delete(sessionId));
}

const server = http.createServer(async (req, res) => {
  try {
    const path = pathnameOf(req);

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      return res.end();
    }

    if (req.method === "GET" && (path === "/" || path === "/health")) {
      return sendJSON(res, 200, {
        ok: true,
        name: SERVER_NAME,
        version: SERVER_VERSION,
        openaiConfigured: Boolean(OPENAI_API_KEY),
        endpoints: {
          streamableHttp: "/mcp",
          legacySse: "/sse",
          health: "/health"
        }
      });
    }

    const isMcpPath = path === "/mcp" || path === "/";
    const isLegacySse = path === "/sse";
    const isLegacyMessages = path === "/messages";

    if ((isMcpPath || isLegacySse || isLegacyMessages) && !isAuthorized(req)) {
      return sendJSON(res, 401, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32004, message: "Unauthorized" }
      });
    }

    if (req.method === "GET" && isLegacySse) {
      return startLegacySse(req, res);
    }

    if (req.method === "GET" && isMcpPath) {
      res.writeHead(405, corsHeaders({
        Allow: "POST, OPTIONS",
        "Content-Type": "application/json"
      }));
      return res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "This server uses Streamable HTTP POST. Use POST /mcp." },
        id: null
      }));
    }

    if (req.method === "DELETE" && isMcpPath) {
      res.writeHead(405, corsHeaders({ Allow: "POST, OPTIONS" }));
      return res.end();
    }

    if (req.method === "POST" && (isMcpPath || isLegacyMessages)) {
      return handleMcpPost(req, res);
    }

    return sendJSON(res, 404, { error: "Not found" });
  } catch (error) {
    return sendJSON(res, 500, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: error.message || "Internal error" }
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`${SERVER_NAME} v${SERVER_VERSION} listening on ${HOST}:${PORT}`);
  console.log("Streamable HTTP endpoint: POST /mcp");
  if (!OPENAI_API_KEY) {
    console.warn("Warning: OPENAI_API_KEY is not set.");
  }
});
