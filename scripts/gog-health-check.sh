#!/bin/bash
# gog-health-check.sh — Google OAuth token health check for Muriel (and any gog account)
# Alerts #agent-tony via Slack if token is invalid or keyring is corrupted.
# Run daily via scheduled agent invocation.

set -euo pipefail

ACCOUNT="${GOG_ACCOUNT:-mikewilliamscfo@gmail.com}"
SLACK_TOKEN="${SLACK_BOT_TOKEN:-}"
ALERT_CHANNEL="${ALERT_CHANNEL:-C0AKL7ESVAM}"  # #agent-tony
KEYRING_DIR="$HOME/Library/Application Support/gogcli/keyring"

# gog installs to ~/.local/bin, which is not on PATH for a launchd/cron context.
# Without this the script dies at `gog auth doctor` under `set -e` and the daily
# check silently stops running — the exact failure class it exists to catch.
export PATH="$HOME/.local/bin:$PATH"
if ! command -v gog > /dev/null 2>&1; then
  echo "[ALERT] gog binary not found on PATH — health check cannot run." >&2
  exit 1
fi

# ── Load SLACK_BOT_TOKEN from keychain if not set in env ──────────────────────
if [[ -z "$SLACK_TOKEN" ]]; then
  SLACK_TOKEN=$(security find-generic-password -s "hive/catalyst/SLACK_BOT_TOKEN" -a "SLACK_BOT_TOKEN" -w 2>/dev/null || true)
fi

# ── Slack alert helper ─────────────────────────────────────────────────────────
slack_alert() {
  local msg="$1"
  if [[ -n "$SLACK_TOKEN" ]]; then
    curl -s -X POST "https://slack.com/api/chat.postMessage" \
      -H "Authorization: Bearer $SLACK_TOKEN" \
      -H "Content-Type: application/json" \
      --data "{\"channel\":\"$ALERT_CHANNEL\",\"text\":\"$msg\"}" \
      > /dev/null
  fi
  echo "[ALERT] $msg"
}

issues=()

# ── 1. Check keyring auth doctor ───────────────────────────────────────────────
echo "Checking gog auth doctor..."
doctor_out=$(gog auth doctor -a "$ACCOUNT" 2>&1)
if echo "$doctor_out" | grep -q "status.*error\|FAIL\|not ok"; then
  issues+=("gog auth doctor reports failure:\n\`\`\`$doctor_out\`\`\`")
fi

# ── 2. Verify token is actually valid with Google ─────────────────────────────
echo "Checking token against Google API..."
api_out=$(gog gmail labels list -a "$ACCOUNT" -p --no-input 2>&1 || true)
if echo "$api_out" | grep -qi "invalid_grant\|expired\|revoked\|unauthorized"; then
  issues+=("Google OAuth token for \`$ACCOUNT\` is *invalid or revoked*. Mike must re-run \`gog login $ACCOUNT\` to restore Muriel's Gmail access. Error: \`$api_out\`")
# A partial re-consent produces a token that is perfectly VALID but missing
# scopes — Google answers 403 insufficient-scope, never invalid_grant. The
# check above cannot see that, so Gmail stays dead while the token looks fine.
# This is the likeliest outcome of a rushed re-auth, so it gets its own arm
# with its own remedy: re-consent, not re-login.
elif echo "$api_out" | grep -qi "insufficient\|ACCESS_TOKEN_SCOPE\|forbidden\|403"; then
  issues+=("Google token for \`$ACCOUNT\` is valid but *missing required scopes* (403). A re-consent granting all requested scopes is needed: \`gog login $ACCOUNT --force-consent\`. Error: \`$api_out\`")
elif echo "$api_out" | grep -qi "error\|failed"; then
  issues+=("Google API call returned an unexpected error: \`$api_out\`")
fi

# ── 3. Check the account actually has a keyring entry ──────────────────────────
# This previously flagged any `_gogcli_key_v1_*` file that had no separate
# plain-text token file beside it, on the theory that the pair going out of sync
# causes `aes.KeyUnwrap integrity check failed`. That model of the layout is
# wrong: key-file-only IS the normal, healthy state. Verified 2026-09-10 against
# the live working keyring and the known-good Jul 6 backup — both contain only
# `_gogcli_key_v1_*` entries and no plain token files, so the old check fired on
# every entry of a perfectly healthy keyring. A daily alerter that always alerts
# trains everyone to ignore it, which is worse than not having one.
#
# Genuine keyring corruption already surfaces in checks 1 and 2 — `gog auth
# doctor` and a real API call both fail loudly on an unwrappable key. What
# neither catches is the account having no entry at all, so that is what is
# checked here.
echo "Checking keyring entry exists for account..."
if [[ -d "$KEYRING_DIR" ]]; then
  # gog names entries `token:<account>`, base64-encoded (unpadded) in the filename.
  expected_suffix=$(printf 'token:%s' "$ACCOUNT" | base64 | tr -d '=\n')
  if ! ls "$KEYRING_DIR"/_gogcli_key_v1_"$expected_suffix"* > /dev/null 2>&1; then
    issues+=("No keyring entry found for \`$ACCOUNT\` in \`$KEYRING_DIR\`. The account has never been logged in, or the keyring was cleared. Fix: \`gog login $ACCOUNT\`")
  fi
else
  issues+=("gog keyring directory missing: \`$KEYRING_DIR\`. No account is logged in. Fix: \`gog login $ACCOUNT\`")
fi

# ── 4. Report ─────────────────────────────────────────────────────────────────
if [[ ${#issues[@]} -eq 0 ]]; then
  echo "✅ gog health check passed — token for $ACCOUNT is valid."
else
  msg=":rotating_light: *gog OAuth health check FAILED* for \`$ACCOUNT\`\n"
  for issue in "${issues[@]}"; do
    msg+="• $issue\n"
  done
  slack_alert "$msg"
  exit 1
fi
