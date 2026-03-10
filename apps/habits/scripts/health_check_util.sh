#!/client/cli/bin/bash
# Health Check Utility Script
# Created: March 6, 2026
# Purpose: Quick operational health checks for Protheus infrastructure

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_disk_space() {
    local threshold=90
    local usage=$(df / | awk 'NR==2 {print $5}' | sed 's/%//')
    
    if [ "$usage" -gt "$threshold" ]; then
        log_error "Disk usage is at ${usage}% (threshold: ${threshold}%)"
        return 1
    else
        log_info "Disk usage: ${usage}% (healthy)"
        return 0
    fi
}

check_memory() {
    local mem_available=$(vm_stat | grep "Pages free" | awk '{print $3}' | sed 's/\.//')
    local mem_total=$(sysctl -n hw.memsize)
    local mem_available_mb=$((mem_available * 4096 / 1024 / 1024))
    local mem_total_mb=$((mem_total / 1024 / 1024))
    
    log_info "Memory: ${mem_available_mb}MB available of ${mem_total_mb}MB total"
}

check_git_status() {
    if [ -d ".git" ]; then
        local uncommitted=$(git status --porcelain | wc -l | tr -d ' ')
        if [ "$uncommitted" -gt 0 ]; then
            log_warn "${uncommitted} uncommitted changes detected"
        else
            log_info "Git working tree clean"
        fi
    else
        log_warn "Not a git repository"
    fi
}

# Main execution
main() {
    echo "=== Protheus Health Check ==="
    echo "Timestamp: $(date)"
    echo ""
    
    check_disk_space
    check_memory
    check_git_status
    
    echo ""
    echo "=== Health check complete ==="
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
