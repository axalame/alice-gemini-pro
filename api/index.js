const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CHARS = 2400;
const MAX_ALICE_TEXT = 1000;
const TOTAL_BUDGET_MS = 4350;
const GEMINI_TIMEOUT_MS = 3950;

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс|найди|поищи|актуальн|сколько стоит|свежие данные|счет матча|кто выиграл|что произошло|что случилось/i.test(text);
}

const DEFAULT_SYSTEM_PROMPT = [
  "Ты — умный голосовой помощник для колонки Яндекс Алиса на базе Google Gemini с живым доступом в интернет.",
  "Твой ответ будет сразу озвучен Алисой вслух через динамик колонки.",
  "Отвечай кратко, понятно и по существу (1–3 полных законченных предложения).",
  "Всегда формулируй законченную мысль и никогда не обрывай предложения.",
  "Используй актуальные данные и факты для вопросов о погоде, новостях, курсах валют и текущих событиях.",
  "СТРОГО ЗАПРЕЩЕНО:",
  "1) Добавлять любые технические слова, префиксы или пометки в начале ответа (такие как 'Friendly response:', 'Response:', 'Ответ:', 'Assistant:');",
  "2) Оборачивать ответ или фразы в любые кавычки;",
  "3) Включать интернет-ссылки (URL), сноски источников [1], Markdown (*, _, #), списки, дефисы и эмодзи.",
  "Начинай сразу с текста ответа, чтобы колонка не произносила лишних слов.",
  "Не здоровайся повторно, если диалог уже начат."
].join(" ");

const DEFAULT_BUTTONS = [
  { title: "Что ты помнишь?", hide: true },
  { title: "Что ты умеешь?", hide: true }
];

/**
 * Проверка команд завершения диалога
 */
function isExitIntent(text) {
  return /^(стоп|хватит|пока|до свидания|закройся|выход|отмена|отбой|завершить)$/i.test(text.trim());
}

/**
 * Проверка команд помощи
 */
function isHelpIntent(text) {
  return /^(помощь|что ты умеешь|справка|правила|как пользоваться)$/i.test(text.trim());
}

/**
 * Проверка команд запоминания фактов
 */
function isRememberIntent(text) {
  const t = String(text || "").trim();
  return /^(?:алиса\s*,?\s*)?(?:запомни|сохрани|запиши)(?:\s*,\s*что|\s+что|\s+мой|\s+моё|\s+мои|\s+обо\s+мне)?\s*(.+)/i.test(t);
}

/**
 * Извлечение текста факта для сохранения
 */
function extractFact(text) {
  const match = text.trim().match(/^(?:алиса\s*,?\s*)?(?:запомни|сохрани|запиши)(?:\s*,\s*что|\s+что|\s+мой|\s+моё|\s+мои|\s+обо\s+мне)?\s*(.+)/i);
  return match ? match[1].trim() : "";
}

/**
 * Проверка запроса информации из памяти
 */
function isRecallIntent(text) {
  return /^(?:алиса\s*,?\s*)?(?:что ты обо мне знаешь|что ты помнишь|что обо мне помнишь|покажи память|что сохранено|мои данные|моя информация)/i.test(text.trim());
}

/**
 * Проверка команды сброса памяти
 */
function isForgetIntent(text) {
  return /^(?:алиса\s*,?\s*)?(?:забудь всё|очисти память|сотри память|удали мои данные|забудь обо мне)/i.test(text.trim());
}

/**
 * Очистка текста от Markdown, URL, сносок поиска и спецсимволов для идеального озвучивания Алисой
 */
function cleanVoiceText(value) {
  let text = String(value ?? "")
    .replace(/^[\s"'«“„]+/, "")
    .replace(/^((?:friendly\s+)?(?:response|answer|output|assistant|ai|голос|ответ|помощник|алиса))\s*[:\-–—]\s*/i, "")
    .replace(/^[\s"'«“„]+/, "")
    .replace(/[\s"'»”]+$/, "")
    .replace(/\[\s*\d+(?:[\s,–-]+\d+)*\s*\]/g, "")
    .replace(/https?:\/\/[^\s]+?(?=[.,!?;:]*(\s|$))/gi, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/(^|\s)[#*>-]+[ \t]*/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, "")
    .replace(/["«»“”„]/g, "")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!text) return "Не удалось сформировать ответ. Попробуйте спросить иначе.";
  if (text.length <= MAX_ALICE_TEXT) return text;

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 250) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

/**
 * Безопасное хранение истории (строго защищает от лимита 10 КБ в session_state)
 */
function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  const valid = history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES);

  let totalChars = 0;
  const result = [];
  for (let i = valid.length - 1; i >= 0; i--) {
    const item = valid[i];
    const textLen = item.text.length;
    if (totalChars + textLen > MAX_HISTORY_CHARS && result.length > 0) break;
    result.unshift({ role: item.role, text: item.text.slice(0, 600) });
    totalChars += textLen;
  }
  return result;
}

/**
 * Очистка и валидация постоянного состояния пользователя (лимит Яндекса 1 КБ)
 */
function safeUserState(userState) {
  if (!userState || typeof userState !== "object") {
    return { facts: [] };
  }
  const facts = Array.isArray(userState.facts)
    ? userState.facts.filter(f => typeof f === "string" && f.trim().length > 0).slice(-8)
    : [];
  return {
    facts: facts.map(f => f.slice(0, 120))
  };
}

/**
 * Формирование ответа по протоколу Яндекс Диалогов
 */
function aliceResponse(
  text,
  endSession = false,
  history = [],
  buttons = DEFAULT_BUTTONS,
  userStateUpdate = null,
  soundPrefix = ""
) {
  const clean = cleanVoiceText(text);
  const tts = soundPrefix ? `${soundPrefix} ${clean}` : clean;
  const res = {
    version: "1.0",
    response: {
      text: clean,
      tts: tts,
      end_session: endSession,
      buttons: endSession ? [] : buttons
    },
    session_state: { history }
  };
  if (userStateUpdate !== null) {
    res.user_state_update = userStateUpdate;
  }
  return res;
}

/**
 * Безопасный запрос с таймаутом
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(150, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Запрос к Google Gemini с автоматическим переключением моделей (fallback) при перегрузке или лимитах 429/503
 */
async function askGemini(text, history, timeoutMs, overrideModel, userContext = "") {
  let rawKey = process.env.GEMINI_API_KEY || process.env.gemini || process.env.GEMINI_KEY || "";
  const key = String(rawKey).replace(/^['"]|['"]$/g, "").trim();
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 300) throw new Error("TIME_BUDGET_EXHAUSTED");

  const preferredModel = String(overrideModel || process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const modelsToTry = [
    preferredModel,
    "gemini-3.5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-3.8-flash"
  ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

  const enableSearchSetting = String(process.env.ENABLE_GOOGLE_SEARCH ?? "auto").toLowerCase().trim();
  const userWantsSearch = enableSearchSetting === "true" || (enableSearchSetting !== "false" && isSearchIntent(text));

  const contents = [];
  for (const h of history) {
    contents.push({
      role: h.role,
      parts: [{ text: h.text }]
    });
  }
  contents.push({
    role: "user",
    parts: [{ text }]
  });

  let fullSystemPrompt = DEFAULT_SYSTEM_PROMPT;
  if (userContext && userContext.trim().length > 0) {
    fullSystemPrompt += ` Дополнительный контекст о пользователе из памяти: ${userContext.trim()}.`;
  }

  let lastError = null;

  for (const model of modelsToTry) {
    const attempts = userWantsSearch ? [{ withSearch: true }, { withSearch: false }] : [{ withSearch: false }];

    for (const attempt of attempts) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

      const requestPayload = {
        system_instruction: {
          parts: [{ text: fullSystemPrompt }]
        },
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 500
        }
      };

      if (attempt.withSearch) {
        requestPayload.tools = [{ google_search: {} }];
      }

      const postBudget = attempt.withSearch ? Math.min(timeoutMs, 2400) : timeoutMs;
      if (postBudget < 250) continue;

      try {
        const { response, data } = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestPayload)
          },
          postBudget
        );

        if (response.ok) {
          const rawAnswer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawAnswer && typeof rawAnswer === "string" && rawAnswer.trim().length > 0) {
            return rawAnswer.trim();
          }
          if (data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason === "SAFETY") {
            throw new Error("GEMINI_BLOCKED");
          }
        }

        const status = response.status;
        const errMessage = data?.error?.message || "";
        const errStatus = data?.error?.status || "";

        if (status === 400 && (errMessage.includes("API key") || errStatus === "INVALID_ARGUMENT")) {
          const err = new Error("GEMINI_KEY_REJECTED");
          err.details = errMessage;
          throw err;
        }

        if (status === 429) {
          lastError = new Error("GEMINI_QUOTA");
        } else {
          lastError = new Error("GEMINI_REQUEST_FAILED");
        }
      } catch (err) {
        if (err.message === "GEMINI_KEY_REJECTED") throw err;
        if (attempt.withSearch && (err.name === "AbortError" || err.message === "TIME_BUDGET_EXHAUSTED")) {
          console.warn("Search attempt timed out, falling back to direct generation...");
          continue;
        }
        lastError = err;
      }
    }
  }

  throw lastError || new Error("GEMINI_REQUEST_FAILED");
}

/**
 * Человекопонятные сообщения об ошибках
 */
function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "В настройках навыка не указан GEMINI_API_KEY. Пожалуйста, добавьте его в переменных окружения Vercel.";
    case "GEMINI_KEY_REJECTED":
      return `Ошибка Google Gemini: ${error?.details || "проверьте правильность API-ключа"}.`;
    case "GEMINI_QUOTA":
      return "Сейчас превышен минутный лимит запросов к нейросети. Подождите пару секунд и повторите вопрос.";
    case "GEMINI_BLOCKED":
      return "Я не могу ответить на этот вопрос из соображений безопасности. Спросите о чём-нибудь другом.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ за отведённое время. Попробуйте задать вопрос чуть короче.";
    default:
      return "Произошла временная заминка при связи с нейросетью. Попробуйте повторить ещё раз.";
  }
}

/**
 * Основной обработчик вебхука Яндекс Диалогов
 */
export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-skill",
      version: "3.6.0",
      status: "ready",
      message: "Webhook is active. Configure Yandex Dialogs to send POST requests to this URL."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (process.env.WEBHOOK_SECRET) {
    const urlToken = req.query?.token;
    if (urlToken !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized webhook secret" });
    }
  }

  const startedAt = Date.now();
  const remainingBudget = () => TOTAL_BUDGET_MS - (Date.now() - startedAt);

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);
  const userState = safeUserState(body?.state?.user);
  const userFacts = userState.facts || [];

  if (body?.debug) {
    const t0 = Date.now();
    try {
      const answer = await askGemini(text || "Тест", oldHistory, 4000, body?.model, userFacts.join("; "));
      return res.status(200).json({ ok: true, duration: Date.now() - t0, answer });
    } catch (err) {
      return res.status(200).json({ ok: false, duration: Date.now() - t0, error: err.message, details: err.details });
    }
  }

  // 1. Первый запуск (Приветствие)
  if (!text) {
    const greeting = process.env.GREETING_MESSAGE || "Привет! Я на связи. О чём хотите узнать?";
    return res.status(200).json(aliceResponse(greeting, false, oldHistory));
  }

  // 2. Быстрый перехват команд завершения
  if (isExitIntent(text)) {
    return res.status(200).json(aliceResponse(
      "До связи! Если снова понадобится помощь — зовите.",
      true,
      []
    ));
  }

  // 3. Быстрый перехват команд помощи
  if (isHelpIntent(text)) {
    return res.status(200).json(aliceResponse(
      "Я умный помощник на базе Google Gemini с живым доступом в интернет. Я умею отвечать на вопросы и помнить факты о вас (скажите «Запомни, что...»).",
      false,
      oldHistory
    ));
  }

  // 4. Команда сброса памяти («Забудь всё»)
  if (isForgetIntent(text)) {
    return res.status(200).json(aliceResponse(
      "Память очищена. Я забыла все сохранённые о вас факты.",
      false,
      oldHistory,
      DEFAULT_BUTTONS,
      { facts: [] },
      '<speaker audio="alice-sounds-game-ping-1.opus">'
    ));
  }

  // 5. Команда просмотра памяти («Что ты обо мне знаешь?»)
  if (isRecallIntent(text)) {
    const answerText = userFacts.length > 0
      ? `Вот что я о вас помню: ${userFacts.join("; ")}. Чтобы удалить данные, скажите «Забудь всё».`
      : "Я пока ничего о вас не сохранила. Вы можете сказать: «Запомни, что...», и я сохраню важные факты.";
    return res.status(200).json(aliceResponse(answerText, false, oldHistory, DEFAULT_BUTTONS));
  }

  // 6. Команда запоминания («Запомни, что...»)
  if (isRememberIntent(text)) {
    const rawFact = extractFact(text);
    if (!rawFact) {
      return res.status(200).json(aliceResponse(
        "Что именно мне запомнить? Скажите, например: «Запомни, что меня зовут Руслан».",
        false,
        oldHistory
      ));
    }
    const newFacts = [...userFacts.filter(f => f.toLowerCase() !== rawFact.toLowerCase()), rawFact].slice(-8);
    const updatedState = { ...userState, facts: newFacts };
    return res.status(200).json(aliceResponse(
      `Запомнила: ${rawFact}. Буду это учитывать!`,
      false,
      oldHistory,
      DEFAULT_BUTTONS,
      updatedState,
      '<speaker audio="alice-sounds-things-bell-1.opus">'
    ));
  }

  // 7. Запрос к Gemini
  try {
    const userContext = userFacts.length > 0 ? userFacts.join("; ") : "";
    const answer = await askGemini(
      text,
      oldHistory,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingBudget() - 250)),
      body?.model,
      userContext
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, 500) },
      { role: "model", text: answer.slice(0, 500) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const isTimeout = error?.name === "AbortError" || error?.message === "TIME_BUDGET_EXHAUSTED";
    const mapped = isTimeout ? new Error("TIME_BUDGET_EXHAUSTED") : error;
    console.warn("Returning graceful fallback response:", mapped.message);
    return res.status(200).json(aliceResponse(errorForUser(mapped), false, oldHistory));
  }
}

export {
  cleanVoiceText,
  safeHistory,
  safeUserState,
  aliceResponse,
  isExitIntent,
  isHelpIntent,
  isSearchIntent,
  isRememberIntent,
  extractFact,
  isRecallIntent,
  isForgetIntent
};
