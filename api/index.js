const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CHARS = 2400;
const MAX_ALICE_TEXT = 1000;
const TOTAL_BUDGET_MS = 4100;
const GEMINI_TIMEOUT_MS = 3500;

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные|счет матча|кто выиграл/i.test(text);
}

const DEFAULT_SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай по-русски, естественно, доброжелательно и емко (обычно 2–3 полных предложения).",
  "Всегда формулируй законченную мысль и не обрывай предложения.",
  "Твой ответ будет озвучен Алисой вслух, поэтому СТРОГО ЗАПРЕЩЕНО:",
  "1) Включать любые интернет-ссылки или URL (например, https://...);",
  "2) Использовать Markdown-символы (звездочки, решетки, жирный шрифт, курсив);",
  "3) Использовать списки с дефисами, маркерами или цифрами;",
  "4) Использовать таблицы и эмодзи.",
  "Не здоровайся повторно, если диалог уже продолжается.",
  "Если вопрос касается актуальных событий, опирайся на проверенные факты."
].join(" ");

const DEFAULT_BUTTONS = [
  { title: "Что ты умеешь?", hide: true },
  { title: "Интересный факт", hide: true },
  { title: "Хватит", hide: true }
];

function isExitIntent(text) {
  return /^(стоп|хватит|пока|до свидания|закройся|выход|отмена|отбой|завершить)$/i.test(text.trim());
}

function isHelpIntent(text) {
  return /^(помощь|что ты умеешь|справка|правила|как пользоваться)$/i.test(text.trim());
}

function cleanVoiceText(value) {
  let text = String(value ?? "")
    .replace(/https?:\/\/[^\s]+?(?=[.,!?;:]*(\s|$))/gi, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/(^|\s)[#*>-]+[ \t]*/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, "")
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

async function askGemini(text, history, timeoutMs) {
  let rawKey = process.env.GEMINI_API_KEY || process.env.gemini || process.env.GEMINI_KEY || "";
  const key = String(rawKey).replace(/^['"]|['"]$/g, "").trim();
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 300) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const systemPrompt = process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
  const enableSearch = process.env.ENABLE_GOOGLE_SEARCH === "true" && isSearchIntent(text);

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));
  contents.push({ role: "user", parts: [{ text }] });

  const requestBody = (withTools) => ({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 400
    },
    ...(withTools ? { tools: [{ googleSearch: {} }] } : {})
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  let { response, data } = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody(enableSearch))
    },
    timeoutMs
  );

  if (!response.ok && enableSearch && response.status === 429) {
    console.warn("Search grounding quota reached; retrying without tools.");
    const retry = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody(false))
      },
      Math.max(1000, timeoutMs - 1000)
    );
    response = retry.response;
    data = retry.data;
  }

  if (!response.ok) {
    const status = Number(response.status);
    console.error("Gemini API error HTTP", status, data?.error?.message);
    if (status === 400 || status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(p => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }

  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "В настройках навыка не указан GEMINI_API_KEY. Пожалуйста, добавьте его в переменных окружения Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось авторизоваться в Google Gemini. Проверьте правильность API-ключа в настройках Vercel.";
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

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-skill",
      version: "2.0.0",
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

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я умный голосовой помощник на базе Google Gemini. Могу отвечать на сложные вопросы или искать свежие данные в интернете. О чём хотите узнать?",
      false,
      oldHistory
    ));
  }

  if (isExitIntent(text)) {
    return res.status(200).json(aliceResponse(
      "До связи! Если снова понадобится помощь — зовите.",
      true,
      []
    ));
  }

  if (isHelpIntent(text)) {
    return res.status(200).json(aliceResponse(
      "Я умею отвечать на вопросы, решать логические задачи, помогать с советами и находить актуальные новости. Просто спросите меня голосом, как обычного собеседника.",
      false,
      oldHistory
    ));
  }

  try {
    const answer = await askGemini(
      text,
      oldHistory,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingBudget() - 400))
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
