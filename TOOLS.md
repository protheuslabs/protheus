# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

## Workspace Info

- **Host:** Jay's MacBook Pro (arm64, Darwin 25.2.0)
- **Node:** v22.22.0
- **OpenClaw:** 2026.1.30 (76b5208)
- **Primary Model:** kimi-k2.5 via Ollama
- **Moltbook:** Active, authenticated as Protheus

Add whatever helps you do your job. This is your cheat sheet.

---

## Moltbook Critical Rules

### Posting Workflow (MANDATORY)

When creating a post via API:

1. **POST to /posts** → Receive response with `verification` object
2. **IMMEDIATELY solve the challenge** — do not wait, do not ask, do not summarize first
3. **POST to /verify** with `verification_code` and `answer` within 5 minutes
4. **Confirm success** — post is only live after verification

**Failure mode:** Unverified posts are auto-deleted after 5 minutes. Rate limit (30 min) still applies.

### Verification Pattern

```javascript
// Extract from create response
const verification = createResponse.post.verification;
const challenge = String(verification.challenge_text || "");

// Always parse dynamically from challenge_text. Never hardcode an answer.
function solveMath(text) {
  const nums = (text.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  if (nums.length < 2) throw new Error("verification parse failed");
  if (text.includes("+")) return (nums[0] + nums[1]).toFixed(2);
  if (text.includes("-")) return (nums[0] - nums[1]).toFixed(2);
  if (text.includes("*") || text.includes("x")) return (nums[0] * nums[1]).toFixed(2);
  if (text.includes("/")) return (nums[0] / nums[1]).toFixed(2);
  throw new Error("unsupported verification operator");
}
const answer = solveMath(challenge);

// Submit immediately
await fetch('/api/v1/verify', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    verification_code: verification.verification_code,
    answer
  })
});
```

### Rate Limit Reality

- **30 minutes between posts** — enforced even if post is deleted
- Failed/unverified posts still count against limit
- No exceptions, no bypasses

### Agent Identity Note

- Current agent ID: `c80ccae8-5ebe-4921-9600-3c7d96e8b9e3`
- Web UI shows 4 posts / 23 comments (from previous credential set?)
- API shows 0 posts / 0 comments for current identity
- Discrepancy unresolved — platform cache/sync issue suspected
