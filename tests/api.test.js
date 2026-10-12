import test from "node:test";
import assert from "node:assert/strict";
import handler, {
  aliceResponse,
  cleanVoiceText,
  safeHistory,
  isExitIntent,
  isHelpIntent
} from "../api/index.js";

test("aliceResponse generates compliant Yandex Dialogs structure", () => {
  const res = aliceResponse("Привет мир", false, [{ role: "user", text: "вопрос" }]);
  assert.equal(res.version, "1.0");
  assert.equal(res.response.text, "Привет мир");
  assert.equal(res.response.tts, "Привет мир");
  assert.equal(res.response.end_session, false);
  assert.ok(Array.isArray(res.response.buttons));
  assert.equal(res.response.buttons.length, 3);
  assert.deepEqual(res.session_state.history, [{ role: "user", text: "вопрос" }]);
});

test("cleanVoiceText removes URLs, markdown and emojis for comfortable voice playback", () => {
  const dirty = "**Жирный текст** и *курсив*. Читайте https://example.com/news! 😄 # Заголовок";
  const clean = cleanVoiceText(dirty);
  assert.equal(clean, "Жирный текст и курсив. Читайте! Заголовок");
  assert.ok(!clean.includes("https://"));
  assert.ok(!clean.includes("**"));
  assert.ok(!clean.includes("😄"));
});

test("cleanVoiceText removes technical prefixes like friendly response and quotes", () => {
  const dirty = 'friendly response: "В Балашихе сегодня облачно, с прояснениями."';
  const clean = cleanVoiceText(dirty);
  assert.equal(clean, "В Балашихе сегодня облачно, с прояснениями.");
});

test("cleanVoiceText truncates overly long responses at sentence boundary", () => {
  const repeated = ("Это первое предложение. ").repeat(60);
  const result = cleanVoiceText(repeated);
  assert.ok(result.length <= 1000);
  assert.ok(result.endsWith("."));
});

test("isExitIntent detects common voice shutdown commands", () => {
  assert.equal(isExitIntent("стоп"), true);
  assert.equal(isExitIntent("хватит"), true);
  assert.equal(isExitIntent("пока"), true);
  assert.equal(isExitIntent("закройся"), true);
  assert.equal(isExitIntent("расскажи анекдот"), false);
});

test("isHelpIntent detects help requests", () => {
  assert.equal(isHelpIntent("что ты умеешь"), true);
  assert.equal(isHelpIntent("помощь"), true);
  assert.equal(isHelpIntent("правила"), true);
  assert.equal(isHelpIntent("кто президент"), false);
});

test("safeHistory enforces limits to avoid Yandex 10KB session_state overflow", () => {
  const input = Array.from({ length: 15 }, (_, i) => ({
    role: i % 2 ? "model" : "user",
    text: "Сообщение " + i
  }));
  const history = safeHistory(input);
  assert.ok(history.length <= 6);
  assert.equal(history[history.length - 1].text, "Сообщение 14");
});

test("GET health check returns 200 with service status", async () => {
  let statusCode = 0;
  let responseData = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { responseData = data; return this; },
    setHeader() {}
  };
  await handler({ method: "GET" }, res);
  assert.equal(statusCode, 200);
  assert.equal(responseData.ok, true);
  assert.equal(responseData.service, "alice-gemini-skill");
});

test("POST with exit intent closes the session without calling external APIs", async () => {
  let statusCode = 0;
  let responseData = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { responseData = data; return this; },
    setHeader() {}
  };
  await handler({
    method: "POST",
    body: { request: { command: "хватит" } }
  }, res);

  assert.equal(statusCode, 200);
  assert.equal(responseData.response.end_session, true);
  assert.match(responseData.response.text, /До связи/);
});

test("POST with help intent responds immediately without calling external APIs", async () => {
  let statusCode = 0;
  let responseData = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { responseData = data; return this; },
    setHeader() {}
  };
  await handler({
    method: "POST",
    body: { request: { command: "что ты умеешь" } }
  }, res);

  assert.equal(statusCode, 200);
  assert.equal(responseData.response.end_session, false);
  assert.match(responseData.response.text, /умею отвечать/);
});
