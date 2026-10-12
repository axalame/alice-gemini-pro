const DEFAULT_MODEL = "gemini-3-flash-preview";
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CHARS = 2400;
const MAX_ALICE_TEXT = 1000;
const TOTAL_BUDGET_MS = 4350;
const GEMINI_TIMEOUT_MS = 3950;

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные|счет матча|кто выиграл/i.test(text);
}

const DEFAULT_SYSTEM_PROMPT = [
  "Ты — голосовой помощник для умной колонки Яндекс Алиса.",
  "Твой ответ будет сразу озвучен Алисой вслух через динамик колонки.",
  "Отвечай кратко, понятно и по существу (1–3 полных законченных предложения).",
  "Всегда формулируй законченную мысль и никогда не обрывай предложения.",
  "Если пользователь спрашивает текущую погоду, точное время или курс валют, кратко ответь в одно предложение, что у тебя нет прямого датчика погоды и точный прогноз лучше спросить у обычной Алисы вне навыка.",
  "СТРОГО ЗАПРЕЩЕНО:",
  "1) Добавлять любые технические слова, префиксы или пометки в начале ответа (такие как 'Friendly response:', 'Response:', 'Ответ:', 'Assistant:');",
  "2) Оборачивать ответ или фразы в любые кавычки;",
  "3) Включать интернет-ссылки, Markdown (*, _, #), списки, дефисы и эмодзи.",
  "Начинай сразу с текста ответа, чтобы колонка не произносила лишних слов.",
  "Не здоровайся повторно, если диалог уже начат."
].join(" ");

const DEFAULT_BUTTONS = [
  { title: "Что ты умеешь?", hide: true },
  { title: "Интересный факт", hide: true },
  { title: "Хватит", hide: true }
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
 * Очистка текста от Markdown, URL и спецсимволов для идеального озвучивания Алисой
 */
function cleanVoiceText(value) {
  let text = String(value ?? "")
    // Удаляем любые кавычки в начале и технические префиксы модели (friendly response:, Ответ:, Response: и т.д.)
    .replace(/^[\s"'«“„]+/, "")
    .replace(/^((?:friendly\s+)?(?:response|answer|output|assistant|ai|голос|ответ|помощник|алиса))\s*[:\-–—]\s*/i, "")
    .replace(/^[\s"'«“„]+/, "")
    .replace(/[\s"'»”]+$/, "")
    // Удаляем URL-ссылки, сохраняя знаки препинания после них
    .replace(/https?:\/\/[^\s]+?(?=[.,!?;:]*(\s|$))/gi, "")
    // Удаляем markdown жирный/курсив (**текст**, *текст*, __текст__)
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    // Удаляем символы заголовков #, маркеров списков и цитат
    .replace(/(^|\s)[#*>-]+[ \t]*/g, "$1")
    // Удаляем обратные кавычки кода
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    // Удаляем эмодзи и спецсимволы
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, "")
    // Удаляем оставшиеся изолированные кавычки для чистоты озвучки
    .replace(/["«»“”„]/g, "")
    // Убираем лишние пробелы перед знаками препинания
    .replace(/\s+([.,!?;:])/g, "$1")
    // Нормализуем пробелы и переводы строк
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!text) return "Не удалось сформировать ответ. Попробуйте спросить иначе.";

  if (text.length <= MAX_ALICE_TEXT) return text;

  // Если текст длиннее лимита, аккуратно режем по концу предложения
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

  // Контролируем общий размер символов
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
 * Формирование ответа по протоколу Яндекс Диалогов
 */
function aliceResponse(text, endSession = false, history = [], buttons = DEFAULT_BUTTONS) {
  const clean = cleanVoiceText(text);
  return {
    version: "1.0",
    response: {
      text: clean,
      tts: clean,
      end_session: endSession,
      buttons: endSession ? [] : buttons
    },
    session_state: { history }
  };
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
async function askGemini(text, history, timeoutMs, overrideModel) {
  let rawKey = process.env.GEMINI_API_KEY || process.env.gemini || process.env.GEMINI_KEY || "";
  const key = String(rawKey).replace(/^['"]|['"]$/g, "").trim();
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 300) throw new Error("TIME_BUDGET_EXHAUSTED");

  const preferredModel = String(overrideModel || process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const modelsToTry = [
    preferredModel,
    preferredModel !== "gemini-3.5-flash" ? "gemini-3.5-flash" : "gemini-3-flash-preview"
  ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

  const systemPrompt = process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));
  contents.push({ role: "user", parts: [{ text }] });

  const requestBody = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 160
    }
  };

  let lastError = null;
  const deadline = Date.now() + timeoutMs;

  for (const model of modelsToTry) {
    const remainingTime = deadline - Date.now();
    if (remainingTime < 800) break;

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const { response, data } = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody)
        },
        remainingTime - 100
      );

      if (response.ok) {
        const candidate = data?.candidates?.[0];
        const answer = (candidate?.content?.parts || [])
          .map(p => (typeof p.text === "string" ? p.text : ""))
          .join("")
          .trim();
        if (answer) return answer;
      }

      const status = Number(response.status);
      console.warn(`Model ${model} returned HTTP ${status}:`, data?.error?.message);

      if (status === 401 || status === 403) {
        throw new Error("GEMINI_KEY_REJECTED");
      }
      if (status === 429) {
        lastError = new Error("GEMINI_QUOTA");
      } else {
        lastError = new Error("GEMINI_REQUEST_FAILED");
      }
    } catch (err) {
      if (err.message === "GEMINI_KEY_REJECTED") throw err;
      lastError = err;
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
  // Healthcheck для Vercel и браузера
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-skill",
      version: "3.0.0",
      status: "ready",
      message: "Webhook is active. Configure Yandex Dialogs to send POST requests to this URL."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Опциональная защита токеном в query (?token=secret)
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

  // 0. Debug режим для диагностики задержки
  if (body?.debug) {
    const t0 = Date.now();
    try {
      const answer = await askGemini(text || "Тест", oldHistory, 4000, body?.model);
      return res.status(200).json({ ok: true, duration: Date.now() - t0, answer });
    } catch (err) {
      return res.status(200).json({ ok: false, duration: Date.now() - t0, error: err.message, details: err.details });
    }
  }

  // 1. Первый запуск (Приветствие)
  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я умный голосовой помощник на базе Google Gemini. Могу отвечать на сложные вопросы или искать свежие данные в интернете. О чём хотите узнать?",
      false,
      oldHistory
    ));
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
      "Я умею отвечать на вопросы, решать логические задачи, помогать с советами и находить актуальные новости. Просто спросите меня голосом, как обычного собеседника.",
      false,
      oldHistory
    ));
  }

  // 4. Запрос к Gemini
  try {
    const answer = await askGemini(
      text,
      oldHistory,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingBudget() - 250)),
      body?.model
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
  aliceResponse,
  isExitIntent,
  isHelpIntent,
  isSearchIntent
};
