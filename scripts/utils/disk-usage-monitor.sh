#!/bin/bash
#
# Disk Usage Monitor Utility
# Author: Rohan Kapoor
# Last Updated: 2026-03-18
#
# Monitors disk usage for Protheus deployments and alerts when thresholds
# are exceeded. Designed to be run via cron or CI health checks.
#
# Usage:
#   ./disk-usage-monitor.sh                    # Check all standard paths
#   ./disk-usage-monitor.sh --notify             # Send alerts if thresholds exceeded
#   ./disk-usage-monitor.sh --path /custom/dir   # Check specific path
#   ./disk-usage-monitor.sh --json               # Output as JSON for metrics ingestion
#
# Exit codes:
#   0 - All checks passed
#   1 - Warning threshold exceeded
#   2 - Critical threshold exceeded
#

set -euo pipefail

# Configuration - modify these thresholds as needed
readonly WARN_THRESHOLD=80
readonly CRITICAL_THRESHOLD=95

# Paths to monitor (customize for your deployment)
MONITOR_PATHS=(
    "/app/logs"
    "/app/state"
    "/tmp"
    "/var/log"
)

# State tracking
MAX_USAGE=0
EXIT_CODE=0
NOTIFY=false
OUTPUT_JSON=false
CUSTOM_PATH=""

# Colors for terminal output (disable if not tty)
if [ -t 1 ]; then
    RED='\033[0;31m'
    YELLOW='\033[1;33m'
    GREEN='\033[0;32m'
    NC='\033[0m' # No Color
else
    RED=''
    YELLOW=''
    GREEN=''
    NC=''
fi

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Parse command line arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --notify)
                NOTIFY=true
                shift
                ;;
            --json)
                OUTPUT_JSON=true
                shift
                ;;
            --path)
                CUSTOM_PATH="$2"
                shift 2
                ;;
            --help|-h)
                echo "Disk Usage Monitor for Protheus"
                echo ""
                echo "Options:"
                echo "  --notify       Send notifications if thresholds exceeded"
                echo "  --json         Output results as JSON"
                echo "  --path PATH    Check specific path instead of defaults"
                echo "  --help         Show this help message"
                exit 0
                ;;
            *)
                echo "Unknown option: $1"
                exit 1
                ;;
        esac
    done
}

# Get disk usage percentage for a path
get_usage() {
    local path="$1"
    df "$path" 2>/dev/null | awk 'NR==2 {print $5}' | sed 's/%//' || echo "0"
}

# Get total size for a path
get_size() {
    local path="$1"
    if [ -d "$path" ]; then
        du -sh "$path" 2>/dev/null | cut -f1 || echo "N/A"
    else
        echo "N/A"
    fi
}

# Check if path exists and is readable
check_path() {
    local path="$1"
    if [ ! -d "$path" ]; then
        return 1
    fi
    if [ ! -r "$path" ]; then
        return 2
    fi
    return 0
}

# Send notification (placeholder - customize for your alerting system)
send_notification() {
    local severity="$1"
    local message="$2"
    
    if [ "$NOTIFY" = true ]; then
        # Example: Send to Slack, PagerDuty, or other alerting system
        # Uncomment and configure based on your setup:
        
        # curl -X POST "$SLACK_WEBHOOK_URL" \
        #     -H 'Content-Type: application/json' \
        #     -d "{\"text\":\"🚨 Disk Alert [$severity]: $message\"}"
        
        log "NOTIFICATION [$severity]: $message"
    fi
}

# Output results as JSON
output_json() {
    local path="$1"
    local usage="$2"
    local size="$3"
    local status="$4"
    
    printf '{"timestamp":"%s","path":"%s","usage_percent":%d,"size":"%s","status":"%s"}\n' \
        "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$path" "$usage" "$size" "$status"
}

# Main check function
check_disk_usage() {
    local path="$1"
    local usage size status
    
    # Check if path is accessible
    check_path "$path"
    local path_status=$?
    
    if [ $path_status -eq 1 ]; then
        if [ "$OUTPUT_JSON" = true ]; then
            output_json "$path" 0 "N/A" "path_not_found"
        else
            log "WARNING: Path does not exist: $path"
        fi
        return
    fi
    
    if [ $path_status -eq 2 ]; then
        if [ "$OUTPUT_JSON" = true ]; then
            output_json "$path" 0 "N/A" "permission_denied"
        else
            log "WARNING: Cannot read path: $path"
        fi
        return
    fi
    
    # Get usage and size
    usage=$(get_usage "$path")
    size=$(get_size "$path")
    
    # Determine status
    if [ "$usage" -ge "$CRITICAL_THRESHOLD" ]; then
        status="critical"
        printf -v status_color "$RED"
    elif [ "$usage" -ge "$WARN_THRESHOLD" ]; then
        status="warning"
        printf -v status_color "$YELLOW"
    else
        status="ok"
        printf -v status_color "$GREEN"
    fi
    
    # Track maximum usage
    if [ "$usage" -gt "$MAX_USAGE" ]; then
        MAX_USAGE=$usage
    fi
    
    # Update exit code
    if [ "$status" = "critical" ]; then
        EXIT_CODE=2
    elif [ "$status" = "warning" ] && [ "$EXIT_CODE" -lt 2 ]; then
        EXIT_CODE=1
    fi
    
    # Output results
    if [ "$OUTPUT_JSON" = true ]; then
        output_json "$path" "$usage" "$size" "$status"
    else
        printf "%-40s %5s%% %8s [%s%s%s]\n" \
            "$path" "$usage" "$size" "$status_color" "$status" "$NC"
    fi
    
    # Send notifications if needed
    if [ "$status" = "critical" ]; then
        send_notification "CRITICAL" "$path is at ${usage}% capacity"
    elif [ "$status" = "warning" ]; then
        send_notification "WARNING" "$path is at ${usage}% capacity"
    fi
}

# Main execution
main() {
    parse_args "$@"
    
    # Header for non-JSON output
    if [ "$OUTPUT_JSON" = false ]; then
        log "=== Protheus Disk Usage Monitor ==="
        log "Checking paths (warn: ${WARN_THRESHOLD}%, critical: ${CRITICAL_THRESHOLD}%)"
        echo ""
    fi
    
    # Determine paths to check
    local paths_to_check
    if [ -n "$CUSTOM_PATH" ]; then
        paths_to_check=("$CUSTOM_PATH")
    else
        paths_to_check=("${MONITOR_PATHS[@]}")
    fi
    
    # Check each path
    for path in "${paths_to_check[@]}"; do
        check_disk_usage "$path"
    done
    
    # Footer for non-JSON output
    if [ "$OUTPUT_JSON" = false ]; then
        echo ""
        if [ $EXIT_CODE -eq 0 ]; then
            log "All disk usage checks passed"
        elif [ $EXIT_CODE -eq 1 ]; then
            log "WARNING: Disk usage threshold exceeded on one or more paths"
        else
            log "CRITICAL: Critical disk usage threshold exceeded"
        fi
    fi
    
    exit $EXIT_CODE
}

# Run main function
main "$@"
