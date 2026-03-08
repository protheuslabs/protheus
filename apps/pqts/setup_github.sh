#!/bin/bash
# Setup script for publishing PQTS to GitHub

echo "🚀 PQTS GitHub Setup"
echo "===================="
echo ""

# Check if git is configured
if ! git config --global user.email > /dev/null 2>&1; then
    echo "⚠️ Git email not configured. Please run:"
    echo "git config --global user.email 'your@email.com'"
    exit 1
fi

if ! git config --global user.name > /dev/null 2>&1; then
    echo "⚠️ Git name not configured. Please run:"
    echo "git config --global user.name 'Your Name'"
    exit 1
fi

echo "✓ Git is configured"
echo ""

# Check if repository exists on GitHub
echo "Checking if repository exists on GitHub..."
REMOTE_EXISTS=$(git ls-remote https://github.com/protheuslabs/pqts.git 2>&1 | grep -v "Repository not found" | wc -l)

if [ "$REMOTE_EXISTS" -eq "0" ]; then
    echo ""
    echo "⚠️ Repository doesn't exist on GitHub yet."
    echo ""
    echo "To create it:"
    echo "1. Visit: https://github.com/new"
    echo "2. Repository name: pqts"
    echo "3. Make it public or private"
    echo "4. Do NOT initialize with README (we already have one)"
    echo "5. Click 'Create repository'"
    echo ""
    echo "After creating, come back and run this script again."
    exit 1
fi

echo "✓ Repository exists on GitHub"
echo ""

# Push to GitHub
echo "Pushing to GitHub..."
git push -u origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Successfully pushed to GitHub!"
    echo ""
    echo "Repository: https://github.com/protheuslabs/pqts"
else
    echo ""
    echo "❌ Push failed. Check your credentials and try again."
fi
