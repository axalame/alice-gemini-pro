---
name: secret-protection
description: >-
  Use this skill whenever handling API keys, tokens, credentials, .env files, or preparing git commits.
  Ensures zero secrets are hardcoded in source code or pushed to public repositories.
---

# 🛡️ Secret Protection & Safe Credential Handling Skill

This skill enforces strict security procedures to prevent credentials and secrets from leaking into Git repositories.

## Workflow

### 1. Handling Incoming Secrets from User
When the user provides an API key, token, or password:
* **STEP 1:** Add it **ONLY** to the local `.env` file.
* **STEP 2:** Verify that `.env` is listed in `.gitignore`.
* **STEP 3:** In the application code, use `process.env.VARIABLE_NAME`.
* **STEP 4:** **NEVER** write fallback default constants with real credentials.
* **STEP 5:** Provide instructions to the user on adding the secret to cloud environment variables (e.g., Vercel, Railway, Docker).

### 2. Pre-Commit Verification Checklist
Before running `git commit`:
1. Run `git diff --cached` to inspect all staged changes.
2. Check for patterns of:
   * Telegram Bot Tokens: `\d{8,12}:[A-Za-z0-9_-]{35}`
   * Gemini / Google API Keys: `AIza[0-9A-Za-z-_]{35}`
   * GitHub Personal Access Tokens: `ghp_[0-9A-Za-z]{36}`
   * Private keys: `BEGIN PRIVATE KEY`
   * Hardcoded passwords or bearer tokens.
3. If any secret is found:
   * **ABORT** commit immediately.
   * Strip the secret.
   * Replace with `process.env`.
