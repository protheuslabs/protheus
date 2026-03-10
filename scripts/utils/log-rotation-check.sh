#!/usr/bin/env bash
#
# Utility: Log Rotation Health Check
# Author: Rohan Kapoor
# Created: 2026-03-08
#
# This script performs routine health checks on log rotation status
# and reports any anomalies. Safe to run manually or via cron.
#
# Usage: ./scripts/utils/log-rotation-check.sh [--verbose]
#

set -euo pipefail

VERBOSE=0
if [[ "${1:-}" == "--verbose" ]]; then
    VERBOSE=1
fi

# Configuration
LOG_DIRS=(
    "${HOME}/.protheus/logs"
    "${HOME}/.openclaw/workspace/logs"
)
MAX_LOG_AGE_DAYS=7
MAX_LOG_SIZE_MB=100

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

# Check if log directories exist
check_directories() {
    local found=0
    for dir in "${LOG_DIRS[@]}"; do
        if [[ -d "$dir" ]]; then
            found=$((found + 1))
            [[ $VERBOSE -eq 1 ]] && log_info "Found log directory: $dir"
        else
            [[ $VERBOSE -eq 1 ]] && log_warn "Directory not found: $dir"
        fi
    done
    
    if [[ $found -eq 0 ]]; then
        log_warn "No log directories found. This may be expected on fresh installs."
        return 1
    fi
    
    return 0
}

# Check for oversized log files
check_file_sizes() {
    local issues=0
    for dir in "${LOG_DIRS[@]}"; do
        [[ -d "$dir" ]] || continue
        
        while IFS= read -r -d '' file; do
            local size_mb
            size_mb=$(du -m "$file" | cut -f1)
            if [[ $size_mb -gt $MAX_LOG_SIZE_MB ]]; then
                log_warn "Large log file detected: $file (${size_mb}MB)"
                issues=$((issues + 1))
            fi
        done < <(find "$dir" -type f -name "*.log" -print0 2>/dev/null || true)
    done
    
    if [[ $issues -eq 0 ]]; then
        [[ $VERBOSE -eq 1 ]] && log_info "All log files within size limits (<${MAX_LOG_SIZE_MB}MB)"
    fi
    
    return 0
}

# Check for stale log files
check_file_age() {
    local issues=0
    for dir in "${LOG_DIRS[@]}"; do
        [[ -d "$dir" ]] || continue
        
        while IFS= read -r -d '' file; do
            log_warn "Old log file detected: $file (may need rotation)"
            issues=$((issues + 1))
        done < <(find "$dir" -type f -name "*.log" -mtime +$MAX_LOG_AGE_DAYS -print0 2>/dev/null || true)
    done
    
    if [[ $issues -eq 0 ]]; then
        [[ $VERBOSE -eq 1 ]] && log_info "No stale log files found (all <${MAX_LOG_AGE_DAYS} days)"
    fi
    
    return 0
}

# Main execution
main() {
    echo "=== Log Rotation Health Check ==="
    echo "Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo ""
    
    check_directories || true
    check_file_sizes || true
    check_file_age || true
    
    echo ""
    log_info "Health check completed"
    
    # Return 0 to indicate script ran successfully (not necessarily that all checks passed)
    exit 0
}

main "$@"
