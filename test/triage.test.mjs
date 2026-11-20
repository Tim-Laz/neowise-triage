import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAppServer } from "../app.mjs";

const manualReview = { status: "manual_review", topic: null, draft: null };

async function startServer(t, classifyRequest) {
  const server = createAppServer(classifyRequest);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(url, body) {
  const response = await fetch(`${url}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  assert.match(response.headers.get("content-type"), /application\/json/);
  return { status: response.status, body: await response.json() };
}

test("invalid input returns 400 without calling AI", async (t) => {
  let calls = 0;
  const url = await startServer(t, async () => { calls += 1; });
  const inputs = [
    ["empty body", ""],
    ["broken JSON", '{"text":'],
    ["missing text", "{}"],
    ["null body", "null"],
    ["array body", "[]"],
    ["string body", '"hello"'],
    ["empty text", JSON.stringify({ text: "" })],
    ["whitespace", JSON.stringify({ text: " \n\t " })],
    ["null text", JSON.stringify({ text: null })],
    ["number", JSON.stringify({ text: 42 })],
    ["boolean", JSON.stringify({ text: true })],
    ["object", JSON.stringify({ text: {} })],
    ["array", JSON.stringify({ text: ["hello"] })],
  ];

  for (const [name, body] of inputs) {
    await t.test(name, async () => {
      assert.deepEqual(await post(url, body), {
        status: 400,
        body: { status: "invalid_input" },
      });
    });
  }
  assert.equal(calls, 0);
});

test("valid text returns a topic and a draft", async (t) => {
  const url = await startServer(t);
  for (const [text, topic] of [
    ["Когда доставка?", "delivery"],
    ["  Какая цена?  ", "pricing"],
    ["Здравствуйте", "other"],
  ]) {
    await t.test(topic, async () => {
      assert.deepEqual(await post(url, JSON.stringify({ text })), {
        status: 200,
        body: {
          status: "ready",
          topic,
          draft: "Спасибо за обращение. Уточним детали заявки.",
        },
      });
    });
  }
});

test("all supplied AI failure scenarios require manual review", async (t) => {
  const url = await startServer(t);
  for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]", "[timeout]"]) {
    await t.test(marker, { timeout: 2000 }, async () => {
      assert.deepEqual(await post(url, JSON.stringify({ text: marker })), {
        status: 200,
        body: manualReview,
      });
    });
  }
});

test("valid JSON with an invalid shape also requires manual review", async (t) => {
  for (const value of [null, [], {}, { topic: "delivery" }, { topic: "pricing", draft: 42 }]) {
    await t.test(JSON.stringify(value), async (t) => {
      const url = await startServer(t, async () => JSON.stringify(value));
      assert.deepEqual(await post(url, JSON.stringify({ text: "Заявка" })), {
        status: 200,
        body: manualReview,
      });
    });
  }
});

test("AI cannot override the response status or add extra fields", async (t) => {
  let receivedText;
  const url = await startServer(t, async (text) => {
    receivedText = text;
    return JSON.stringify({ status: "wrong", topic: "other", draft: "  Ответ  ", extra: true });
  });
  assert.deepEqual(await post(url, JSON.stringify({ text: "  Заявка  " })), {
    status: 200,
    body: { status: "ready", topic: "other", draft: "Ответ" },
  });
  assert.equal(receivedText, "Заявка");
});

test("300 ms timeout works even if AI ignores cancellation", { timeout: 2000 }, async (t) => {
  let signal;
  const url = await startServer(t, (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  const started = performance.now();
  assert.deepEqual(await post(url, JSON.stringify({ text: "Заявка" })), {
    status: 200,
    body: manualReview,
  });
  const elapsed = performance.now() - started;
  assert.equal(signal.aborted, true);
  // Допуск на HTTP и загрузку машины. Ожидание 1200 мс этот тест не пройдёт.
  assert.ok(elapsed >= 250 && elapsed < 1000, `Response took ${elapsed.toFixed(0)} ms`);
});

test("a failed request does not affect the next successful one", async (t) => {
  const url = await startServer(t);
  await post(url, JSON.stringify({ text: "[error]" }));
  const reply = await post(url, JSON.stringify({ text: "Какая цена?" }));
  assert.equal(reply.status, 200);
  assert.equal(reply.body.status, "ready");
  assert.equal(reply.body.topic, "pricing");
});

test("serves the page and rejects unknown routes", async (t) => {
  const url = await startServer(t);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /<form/);

  for (const path of ["/missing", "/api/triage"]) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { status: "not_found" });
  }
});
