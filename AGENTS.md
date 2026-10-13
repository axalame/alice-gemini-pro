# 🛡️ AGENT SECURITY & SECRETS POLICY

## ⛔ ZERO-LEAK MANDATE

1. **NO SECRETS IN CODE:**
   - Under NO circumstances may any API key, bot token, password, private key, or credential be written into source files, even as fallbacks (`const DEFAULT_TOKEN = "..."`).
   - All credentials MUST be read strictly from `process.env`.

2. **SECRETS ONLY IN `.env` / HOSTING DASHBOARD:**
   - Real keys belong ONLY in `.env` (which must be in `.gitignore`).
   - Tell user to set secrets in their cloud environment (Vercel Environment Variables).

3. **PRE-COMMIT SANITY CHECK:**
   - Inspect `git diff --cached` before every commit.
   - Scan for regexes: Telegram bot tokens (`\d{8,12}:[A-Za-z0-9_-]{35}`), Gemini API keys (`AIza[0-9A-Za-z-_]{35}`), GitHub PATs (`ghp_...`).
   - If found, abort commit immediately.
