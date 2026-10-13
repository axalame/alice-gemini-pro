import test from "node:test";
import assert from "node:assert/strict";
import handler, {
  aliceResponse,
  cleanVoiceText,
  safeHistory,
  safeUserState,
  isExitIntent,
  isHelpIntent,
  isSearchIntent,
  isRememberIntent,
  extractFact,
  isRecallIntent,
  isForgetIntent
} from "../api/index.js";

test("aliceResponse generates compliant Yandex Dialogs structure with user_state_update and sounds", () => {
  const userState = { facts: ["тест"] };
  const res = aliceResponse(
    "Привет мир",
    false,
    [{ role: "user", text: "вопрос" }],
    undefined,
    userState,
    '<speaker audio="alice-sounds-things-bell-1.opus">'
  );
  assert.equal(res.version, "1.0");
  assert.equal(res.response.text, "Привет мир");
  assert.equal(res.response.tts, '<speaker audio="alice-sounds-things-bell-1.opus"> Привет мир');
  assert.equal(res.response.end_session, false);
  assert.ok(Array.isArray(res.response.buttons));
  assert.deepEqual(res.session_state.history, [{ role: "user", text: "вопрос" }]);
  assert.deepEqual(res.user_state_update, userState);
});

test("cleanVoiceText removes URLs, markdown and emojis for comfortable voice playback", () => {
  const dirty = "**Жирный текст** и *курсив*. Читайте https://example.com/news! 😄 # Заголовок";
  const clean = cleanVoiceText(dirty);
  assert.equal(clean, "Жирный текст и курсив. Читайте! Заголовок");
  assert.ok(!clean.includes("https://"));
  assert.ok(!clean.includes("**"));
  assert.ok(!clean.includes("😄"));
});

test("cleanVoiceText removes search grounding citations like [1] and [2, 3]", () => {
  const grounded = "Сегодня в Балашихе +14 градусов [1]. Ожидается переменная облачность [2, 3].";
  const clean = cleanVoiceText(grounded);
  assert.equal(clean, "Сегодня в Балашихе +14 градусов. Ожидается переменная облачность.");
  assert.ok(!clean.includes("[1]"));
  assert.ok(!clean.includes("[2, 3]"));
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

test("isSearchIntent detects queries requiring real-time search", () => {
  assert.equal(isSearchIntent("какая сегодня погода в Балашихе"), true);
  assert.equal(isSearchIntent("свежие новости технологий"), true);
  assert.equal(isSearchIntent("курс доллара сейчас"), true);
  assert.equal(isSearchIntent("кто выиграл матч вчера"), true);
  assert.equal(isSearchIntent("найди информацию о телескопе"), true);
  assert.equal(isSearchIntent("привет как дела"), false);
});

test("Memory intent recognizers work accurately", () => {
  assert.equal(isRememberIntent("запомни, что меня зовут Руслан"), true);
  assert.equal(isRememberIntent("сохрани я живу в Балашихе"), true);
  assert.equal(extractFact("запомни, что меня зовут Руслан"), "меня зовут Руслан");
  assert.equal(extractFact("сохрани мой размер обуви 43"), "размер обуви 43");

  assert.equal(isRecallIntent("что ты обо мне знаешь"), true);
  assert.equal(isRecallIntent("что ты помнишь"), true);
  assert.equal(isForgetIntent("забудь всё"), true);
  assert.equal(isForgetIntent("очисти память"), true);
});

test("safeUserState limits facts to avoid 1KB Yandex overflow", () => {
  const messy = {
    facts: Array.from({ length: 20 }, (_, i) => "Факт " + i)
  };
  const safe = safeUserState(messy);
  assert.ok(safe.facts.length <= 8);
  assert.equal(safe.facts[safe.facts.length - 1], "Факт 19");
});

test("POST with remember intent updates user_state_update without calling Gemini", async () => {
  let statusCode = 0;
  let responseData = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { responseData = data; return this; },
    setHeader() {}
  };
  await handler({
    method: "POST",
    body: {
      request: { command: "запомни, что меня зовут Руслан" },
      state: { user: { facts: ["живу в Балашихе"] } }
    }
  }, res);

  assert.equal(statusCode, 200);
  assert.match(responseData.response.text, /Запомнила/);
  assert.ok(responseData.response.tts.includes("alice-sounds-things-bell-1.opus"));
  assert.deepEqual(responseData.user_state_update.facts, ["живу в Балашихе", "меня зовут Руслан"]);
});

test("POST with recall intent returns saved facts", async () => {
  let statusCode = 0;
  let responseData = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { responseData = data; return this; },
    setHeader() {}
  };
  await handler({
    method: "POST",
    body: {
      request: { command: "что ты обо мне знаешь" },
      state: { user: { facts: ["меня зовут Руслан", "живу в Балашихе"] } }
    }
  }, res);

  assert.equal(statusCode, 200);
  assert.match(responseData.response.text, /Руслан/);
  assert.match(responseData.response.text, /Балашихе/);
});

test("POST with forget intent clears user_state_update", async () => {
  let statusCode = 0;
  let responseData = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { responseData = data; return this; },
    setHeader() {}
  };
  await handler({
    method: "POST",
    body: {
      request: { command: "забудь всё" },
      state: { user: { facts: ["факт 1"] } }
    }
  }, res);

  assert.equal(statusCode, 200);
  assert.match(responseData.response.text, /Память очищена/);
  assert.deepEqual(responseData.user_state_update.facts, []);
});

test("POST with exit intent closes session cleanly", async () => {
  let statusCode = 0;
  let responseData = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { responseData = data; return this; },
    setHeader() {}
  };
  await handler({
    method: "POST",
    body: {
      request: { command: "стоп" }
    }
  }, res);

  assert.equal(statusCode, 200);
  assert.equal(responseData.response.end_session, true);
});
