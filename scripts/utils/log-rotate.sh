#!/bin/bash
#
# Log Rotation Utility for Protheus Infrastructure
# Author: Rohan Kapoor
# Last Updated: 2026-03-15
#
# This script handles log rotation for Protheus services, compressing
# old logs and cleaning up archives beyond retention period.
#
# Usage: ./log-rotate.sh [service-name] [--dry-run]
#

set -euo pipefail

# Configuration
LOG_BASE_DIR="${PROTHEUS_LOG_DIR:-/var/log/protheus}"
RETENTION_DAYS="${LOG_RETENTION_DAYS:-30}"
COMPRESS_AFTER_DAYS=7
MAX_LOG_SIZE_MB=100

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Show usage
usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS] [SERVICE-NAME]

Rotate and compress logs for Protheus services.

Options:
    -d, --dry-run       Show what would be done without making changes
    -h, --help          Show this help message
    -v, --verbose       Enable verbose output

Examples:
    $(basename "$0")              # Rotate all service logs
    $(basename "$0") core         # Rotate only core service logs
    $(basename "$0") --dry-run      # Preview rotation actions

EOF
}

# Parse arguments
DRY_RUN=false
VERBOSE=false
SERVICE_NAME=""

while [[ $# -gt 0 ]]; do
    case $1 in
        -d|--dry-run)
            DRY_RUN=true
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            log_error "Unknown option: $1"
            usage
            exit 1
            ;;
        *)
            SERVICE_NAME="$1"
            shift
            ;;
    esac
done

# Validate log directory exists
if [[ ! -d "$LOG_BASE_DIR" ]]; then
    log_error "Log directory does not exist: $LOG_BASE_DIR"
    log_info "Set PROTHEUS_LOG_DIR environment variable to override"
    exit 1
fi

# Determine which services to process
if [[ -n "$SERVICE_NAME" ]]; then
    SERVICES=("$SERVICE_NAME")
    log_info "Processing logs for service: $SERVICE_NAME"
else
    # Auto-discover services from log directory
    SERVICES=()
    for dir in "$LOG_BASE_DIR"/*/; do
        if [[ -d "$dir" ]]; then
            SERVICES+=("$(basename "$dir")")
        fi
    done
    log_info "Discovered ${#SERVICES[@]} service log directories"
fi

# Track statistics
TOTAL_ROTATED=0
TOTAL_COMPRESSED=0
TOTAL_DELETED=0

# Process each service
for service in "${SERVICES[@]}"; do
    service_dir="$LOG_BASE_DIR/$service"
    
    if [[ ! -d "$service_dir" ]]; then
        log_warn "Service log directory not found: $service_dir"
        continue
    fi
    
    [[ "$VERBOSE" == true ]] && log_info "Processing $service..."
    
    # Rotate current logs if they exceed size threshold
    for logfile in "$service_dir"/*.log; do
        [[ -f "$logfile" ]] || continue
        
        file_size_mb=$(du -m "$logfile" | cut -f1)
        
        if [[ $file_size_mb -gt $MAX_LOG_SIZE_MB ]]; then
            timestamp=$(date +%Y%m%d-%H%M%S)
            rotated_name="${logfile%.log}-${timestamp}.log"
            
            if [[ "$DRY_RUN" == true ]]; then
                log_info "[DRY-RUN] Would rotate: $logfile (${file_size_mb}MB)"
            else
                mv "$logfile" "$rotated_name"
                log_info "Rotated: $(basename "$logfile") -> $(basename "$rotated_name")"
                ((TOTAL_ROTATED++))
            fi
        fi
    done
    
    # Compress logs older than COMPRESS_AFTER_DAYS
    find "$service_dir" -name "*.log" -mtime +$COMPRESS_AFTER_DAYS -type f | while read -r oldlog; do
        if [[ "$DRY_RUN" == true ]]; then
            log_info "[DRY-RUN] Would compress: $(basename "$oldlog")"
        else
            gzip "$oldlog"
            log_info "Compressed: $(basename "$oldlog").gz"
            ((TOTAL_COMPRESSED++))
        fi
    done
    
    # Delete archives older than RETENTION_DAYS
    find "$service_dir" -name "*.gz" -mtime +$RETENTION_DAYS -type f | while read -r archive; do
        if [[ "$DRY_RUN" == true ]]; then
            log_info "[DRY-RUN] Would delete: $(basename "$archive")"
        else
            rm "$archive"
            log_info "Deleted old archive: $(basename "$archive")"
            ((TOTAL_DELETED++))
        fi
    done
done

# Summary
echo ""
log_info "Log rotation complete"
if [[ "$DRY_RUN" == true ]]; then
    log_info "Dry run mode - no changes were made"
else
    log_info "Rotated: $TOTAL_ROTATED | Compressed: $TOTAL_COMPRESSED | Deleted: $TOTAL_DELETED"
fi

# TODO(rohan): Add S3 archival integration for compliance requirements
# See: https://wiki.protheus.io/compliance-log-retention

exit 0
