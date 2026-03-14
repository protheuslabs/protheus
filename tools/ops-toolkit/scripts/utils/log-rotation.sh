#!/usr/bin/env bash
# =============================================================================
# Log Rotation Utility for Protheus Services
# Author: Rohan Kapoor <rohan@example.com>
# Version: 1.0.0
# Last Updated: 2026-03-14
#
# DESCRIPTION:
#   Automated log rotation script for containerized services. Handles
#   log compression, archival to S3, and cleanup of old log files.
#   Designed to run as a Kubernetes CronJob or systemd timer.
#
# USAGE:
#   ./log-rotation.sh [--service <name>] [--retention-days <days>]
#
# REQUIREMENTS:
#   - kubectl configured with appropriate permissions
#   - aws-cli (if S3 archival enabled)
#   - gzip
#
# CRON EXAMPLE:
#   0 2 * * * /opt/ops-toolkit/scripts/utils/log-rotation.sh --retention-days 30
# =============================================================================

set -euo pipefail

# --- Configuration -----------------------------------------------------------
readonly SCRIPT_VERSION="1.0.0"
readonly DEFAULT_RETENTION_DAYS=30
readonly DEFAULT_S3_BUCKET="protheus-logs-archive"
readonly LOG_BASE_DIR="/var/log/protheus"
readonly ARCHIVE_DIR="${LOG_BASE_DIR}/archives"
readonly LOCK_FILE="/var/run/log-rotation.lock"

# --- Colors ------------------------------------------------------------------
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly RED='\033[0;31m'
readonly NC='\033[0m'

# --- Globals -----------------------------------------------------------------
SERVICE=""
RETENTION_DAYS=${DEFAULT_RETENTION_DAYS}
S3_UPLOAD=false
DRY_RUN=false
VERBOSE=false

# =============================================================================
# Utility Functions
# =============================================================================

log_info() {
    echo -e "${GREEN}[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] INFO:${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] WARN:${NC} $*"
}

log_error() {
    echo -e "${RED}[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] ERROR:${NC} $*"
}

log_verbose() {
    [[ "${VERBOSE}" == "true" ]] && echo -e "${YELLOW}[VERBOSE]${NC} $*"
}

# =============================================================================
# Lock Management
# =============================================================================

acquire_lock() {
    if [[ -f "${LOCK_FILE}" ]]; then
        local pid
        pid=$(cat "${LOCK_FILE}")
        if kill -0 "${pid}" 2>/dev/null; then
            log_error "Another instance is running (PID: ${pid})"
            exit 1
        else
            log_warn "Removing stale lock file"
            rm -f "${LOCK_FILE}"
        fi
    fi
    
    echo $$ > "${LOCK_FILE}"
    trap 'rm -f "${LOCK_FILE}"' EXIT
}

# =============================================================================
# Log Rotation Functions
# =============================================================================

rotate_service_logs() {
    local service_name="$1"
    local service_log_dir="${LOG_BASE_DIR}/${service_name}"
    
    log_info "Processing logs for service: ${service_name}"
    
    if [[ ! -d "${service_log_dir}" ]]; then
        log_warn "Log directory not found: ${service_log_dir}"
        return 0
    fi
    
    # Create archive directory if needed
    local service_archive_dir="${ARCHIVE_DIR}/${service_name}"
    if [[ "${DRY_RUN}" != "true" ]]; then
        mkdir -p "${service_archive_dir}"
    fi
    
    # Find and rotate logs older than 1 day
    local rotated_count=0
    local total_size=0
    
    while IFS= read -r log_file; do
        [[ -z "${log_file}" ]] && continue
        
        local basename
        basename=$(basename "${log_file}")
        local archive_name="${basename}.$(date +%Y%m%d).gz"
        local archive_path="${service_archive_dir}/${archive_name}"
        
        log_verbose "Rotating: ${log_file} -> ${archive_path}"
        
        if [[ "${DRY_RUN}" == "true" ]]; then
            log_info "[DRY RUN] Would compress: ${log_file}"
        else
            # Compress log file
            if gzip -c "${log_file}" > "${archive_path}"; then
                # Truncate original log (safer than deletion for running services)
                : > "${log_file}"
                ((rotated_count++))
                
                local file_size
                file_size=$(stat -f%z "${archive_path}" 2>/dev/null || stat -c%s "${archive_path}" 2>/dev/null || echo "0")
                ((total_size += file_size))
            else
                log_error "Failed to compress: ${log_file}"
            fi
        fi
    done < <(find "${service_log_dir}" -name "*.log" -type f -mtime +0 2>/dev/null)
    
    log_info "Rotated ${rotated_count} log files (${total_size} bytes compressed)"
    
    # Upload to S3 if enabled
    if [[ "${S3_UPLOAD}" == "true" ]] && [[ ${rotated_count} -gt 0 ]]; then
        upload_to_s3 "${service_archive_dir}"
    fi
}

upload_to_s3() {
    local local_dir="$1"
    local s3_prefix="s3://${DEFAULT_S3_BUCKET}/$(date +%Y/%m/%d)"
    
    log_info "Uploading archives to S3: ${s3_prefix}"
    
    if [[ "${DRY_RUN}" == "true" ]]; then
        log_info "[DRY RUN] Would upload: ${local_dir}/* to ${s3_prefix}/"
        return 0
    fi
    
    if ! command -v aws &> /dev/null; then
        log_error "aws-cli not found. Skipping S3 upload."
        return 1
    fi
    
    # Upload with server-side encryption
    if aws s3 sync "${local_dir}/" "${s3_prefix}/" --sse AES256 --only-show-errors; then
        log_info "S3 upload completed successfully"
        
        # Clean up local archives after successful upload
        find "${local_dir}" -name "*.gz" -type f -delete
        log_info "Cleaned up local archives after S3 upload"
    else
        log_error "S3 upload failed"
        return 1
    fi
}

cleanup_old_archives() {
    log_info "Cleaning up archives older than ${RETENTION_DAYS} days"
    
    local deleted_count=0
    
    while IFS= read -r archive_file; do
        [[ -z "${archive_file}" ]] && continue
        
        log_verbose "Deleting old archive: ${archive_file}"
        
        if [[ "${DRY_RUN}" == "true" ]]; then
            log_info "[DRY RUN] Would delete: ${archive_file}"
        else
            rm -f "${archive_file}"
            ((deleted_count++))
        fi
    done < <(find "${ARCHIVE_DIR}" -name "*.gz" -type f -mtime +${RETENTION_DAYS} 2>/dev/null)
    
    log_info "Cleaned up ${deleted_count} old archives"
}

# =============================================================================
# Main Execution
# =============================================================================

show_help() {
    cat <<EOF
Log Rotation Utility v${SCRIPT_VERSION}

Usage: $(basename "$0") [OPTIONS]

Options:
    -s, --service <name>       Rotate logs for specific service only
    -r, --retention-days <n>   Days to retain archives (default: ${DEFAULT_RETENTION_DAYS})
    --s3-upload                Upload archives to S3 after rotation
    --dry-run                  Show what would be done without executing
    -v, --verbose              Enable verbose output
    -h, --help                 Show this help message

Examples:
    $(basename "$0") --retention-days 7
    $(basename "$0") --service payment-api --s3-upload
    $(basename "$0") --dry-run --verbose

Environment Variables:
    S3_BUCKET                  Override default S3 bucket
    LOG_BASE_DIR               Override default log directory
EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -s|--service)
                SERVICE="$2"
                shift 2
                ;;
            -r|--retention-days)
                RETENTION_DAYS="$2"
                shift 2
                ;;
            --s3-upload)
                S3_UPLOAD=true
                shift
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            -v|--verbose)
                VERBOSE=true
                shift
                ;;
            -h|--help)
                show_help
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done
}

main() {
    echo "================================================================"
    echo "  Log Rotation Utility v${SCRIPT_VERSION}"
    echo "================================================================"
    echo ""
    
    parse_args "$@"
    
    log_info "Starting log rotation"
    log_info "Retention period: ${RETENTION_DAYS} days"
    log_info "S3 upload: ${S3_UPLOAD}"
    log_info "Dry run: ${DRY_RUN}"
    
    # Acquire lock to prevent concurrent runs
    acquire_lock
    
    # Ensure directories exist
    if [[ "${DRY_RUN}" != "true" ]]; then
        mkdir -p "${LOG_BASE_DIR}" "${ARCHIVE_DIR}"
    fi
    
    # Rotate logs for specific service or all services
    if [[ -n "${SERVICE}" ]]; then
        rotate_service_logs "${SERVICE}"
    else
        # Discover all service log directories
        for service_dir in "${LOG_BASE_DIR}"/*/; do
            if [[ -d "${service_dir}" ]]; then
                local service_name
                service_name=$(basename "${service_dir}")
                rotate_service_logs "${service_name}"
            fi
        done
    fi
    
    # Clean up old archives
    cleanup_old_archives
    
    log_info ""
    log_info "✅ Log rotation completed successfully"
    
    return 0
}

main "$@"
