#!/bin/bash
# Push PQTS to GitHub
# Requires GitHub CLI or a GitHub Personal Access Token

echo "====================================="
echo "  Pushing PQTS to GitHub"
echo "====================================="

# Check if gh is installed and authenticated
if command -v gh &> /dev/null; then
    echo "✓ GitHub CLI found"
    
    # Check authentication
    if gh auth status &> /dev/null; then
        echo "✓ Authenticated with GitHub"
        
        # Create repo and push
        cd "$(dirname "$0")"
        gh repo create protheuslabs/pqts \
            --public \
            --description "Protheus Quant Trading System - Multi-market algorithmic trading platform with ML" \
            --source=. \
            --remote=origin \
            --push
        
        echo ""
        echo "✅ Repository created and pushed!"
        echo "   URL: https://github.com/protheuslabs/pqts"
    else
        echo "✗ Not authenticated with GitHub"
        echo ""
        echo "Please run: gh auth login"
        echo "Or set GH_TOKEN environment variable"
        exit 1
    fi
else
    echo "✗ GitHub CLI not found"
    echo ""
    echo "Install with: brew install gh"
    echo "Or use alternative method with personal access token:"
    echo ""
    echo "1. Create token at: https://github.com/settings/tokens/new"
    echo "2. Run: export GH_TOKEN=your_token_here"
    echo "3. Run this script again"
fi
