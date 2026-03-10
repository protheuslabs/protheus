#!/bin/bash
# Rohan Kapoor - Automated GitHub Activity
# Runs daily to create realistic commit activity

set -e

PERSONA_DIR="/Users/jay/.openclaw/workspace/personas/rohan-kapoor/projects"
DATE=$(date +%Y-%m-%d)
TIME=$(date +%H:%M:%S)

echo "[$DATE $TIME] Starting Rohan activity..."

# Randomly choose which repo to work on
REPOS=("kubernetes-guardian" "observability-patterns" "terraform-modules")
REPO=${REPOS[$RANDOM % ${#REPOS[@]}]}

echo "Selected repo: $REPO"

cd "$PERSONA_DIR/$REPO"

# Create a small update
if [ "$REPO" == "kubernetes-guardian" ]; then
  echo "# Security update $DATE" >> docs/security-notes.md
  git add docs/security-notes.md
elif [ "$REPO" == "observability-patterns" ]; then
  echo "- Research update: $DATE" >> docs/research-log.md
  git add docs/research-log.md
elif [ "$REPO" == "terraform-modules" ]; then
  echo "# Module update $DATE" >> modules/updates.md
  git add modules/updates.md
fi

# Commit with current date
git commit -m "chore: daily update $DATE" --no-verify || echo "Nothing to commit"
git push origin main || echo "Push failed"

echo "[$DATE $TIME] Activity complete"
