const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

const sessions = new Map();

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function askOpenAI(message) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: message
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "OpenAI API request failed.");
  }

  return data.output_text || "";
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });
    return res.end();
  }

  // MCP SSE connection
  if (req.method === "GET" && req.url === "/sse") {
    const sessionId = crypto.randomUUID();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });

    sessions.set(sessionId, res);

    res.write(`event: endpoint\n`);
    res.write(`data: /messages?sessionId=${sessionId}\n\n`);

    req.on("close", () => {
      sessions.delete(sessionId);
    });

    return;
  }

  // MCP messages
  if (req.method === "POST" && req.url.startsWith("/messages")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId");

    const body = await readBody(req);
    const request = JSON.parse(body);

    let result;

    if (request.method === "initialize") {
      result = {
        protocolVersion: request.params?.protocolVersion || "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "grok-openai-mcp",
          version: "1.0.0"
        }
      };
    }

    else if (request.method === "notifications/initialized") {
      return sendJSON(res, 202, {});
    }

    else if (request.method === "tools/list") {
      result = {
        tools: [
          {
            name: "ask_chatgpt",
            description: "Send a question or request to an OpenAI model and return its response.",
            inputSchema: {
              type: "object",
              properties: {
                message: {
                  type: "string",
                  description: "The question or request to send to OpenAI."
                }
              },
              required: ["message"]
            }
          }
        ]
      };
    }

    else if (request.method === "tools/call") {
      const name = request.params?.name;
      const message = request.params?.arguments?.message;

      if (name !== "ask_chatgpt") {
        return sendJSON(res, 400, {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32601,
            message: "Unknown tool."
          }
        });
      }

      try {
        const answer = await askOpenAI(message);

        result = {
          content: [
            {
              type: "text",
              text: answer
            }
          ]
        };
      } catch (error) {
        result = {
          isError: true,
          content: [
            {
              type: "text",
              text: error.message
            }
          ]
        };
      }
    }

    else {
      return sendJSON(res, 400, {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32601,
          message: "Method not found."
        }
      });
    }

    return sendJSON(res, 200, {
      jsonrpc: "2.0",
      id: request.id,
      result
    });
  }

  sendJSON(res, 404, {
    error: "Not found"
  });
});

server.listen(PORT, () => {
  console.log(`MCP server running on port ${PORT}`);
});
