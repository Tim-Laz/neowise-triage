import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const topics = new Set(["delivery", "pricing", "other"]);
const modelTimeout = 300;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function classifyWithTimeout(text, classifyRequest) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("AI timeout"));
      controller.abort();
    }, modelTimeout);
  });

  try {
    // Ограничиваем ожидание, даже если провайдер не поддерживает signal.
    return await Promise.race([
      classifyRequest(text, { signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response, classifyRequest) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);

  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }

  if (typeof input?.text !== "string" || !input.text.trim()) {
    return json(response, 400, { status: "invalid_input" });
  }

  try {
    const raw = await classifyWithTimeout(input.text.trim(), classifyRequest);
    const result = JSON.parse(raw);
    if (
      !topics.has(result?.topic) ||
      typeof result?.draft !== "string" ||
      !result.draft.trim()
    ) {
      throw new Error("Invalid AI response");
    }

    return json(response, 200, {
      status: "ready",
      topic: result.topic,
      draft: result.draft.trim(),
    });
  } catch {
    return json(response, 200, {
      status: "manual_review",
      topic: null,
      draft: null,
    });
  }
}

export function createAppServer(classifyRequest = classify) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, classifyRequest);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}
