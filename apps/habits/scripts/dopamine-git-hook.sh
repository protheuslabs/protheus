#!/client/cli/bin/bash
#
# post-commit hook - Auto-capture artifacts after each git commit
# Install: ln -sf /Users/jay/.openclaw/workspace/client/cognition/habits/scripts/dopamine-git-hook.sh .git/hooks/post-commit
#

cd /Users/jay/.openclaw/workspace || exit 0

# Run autocap silently (suppress output unless error)
/Users/jay/.local/client/cli/bin/dop autocap git > /dev/null 2>&1

# Optional: Log that artifacts were captured
# echo "🤖 Artifacts auto-captured from commit" >&2

exit 0
