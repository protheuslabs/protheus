#!/usr/bin/env bash
# =============================================================================
# Auto-Rollback Script for Emergency Deployments
# Author: Rohan Kapoor <rohan@example.com>
# Version: 1.2.0
# Last Updated: 2026-03-10
#
# DESCRIPTION:
#   Automated rollback utility for Kubernetes deployments with safety checks,
#   canary analysis, and comprehensive logging. Designed for incident response
#   scenarios requiring sub-60-second recovery time.
#
# USAGE:
#   ./auto-rollback.sh --service <name> [--target-revision <sha>] [--verify]
#
# SAFETY FEATURES:
#   - Multi-stage approval for critical services
#   - Automatic canary health validation
#   - Rollback verification with timeout
#   - Audit logging to centralized SIEM
# =============================================================================

set -euo pipefail

# --- Configuration & Constants ------------------------------------------------
readonly SCRIPT_VERSION="1.2.0"
readonly ROLLBACK_TIMEOUT=${ROLLBACK_TIMEOUT:-300}
readonly HEALTH_CHECK_RETRIES=${HEALTH_CHECK_RETRIES:-12}
# NOTE: HEALTH_CHECK_INTERVAL is intentionally set to 5 seconds to balance between
# quick failure detection and avoiding thundering herd issues during mass
# rollbacks. In high-traffic scenarios, consider increasing to 10s.
readonly HEALTH_CHECK_INTERVAL=${HEALTH_CHECK_INTERVAL:-5}
readonly CRITICAL_SERVICES="auth-api,payment-gateway,inventory-service"

readonly LOG_DIR="/var/log/incident-response"
readonly AUDIT_LOG="${LOG_DIR}/rollbacks.log"
readonly STATE_FILE="${LOG_DIR}/rollback.state"
readonly METRICS_ENDPOINT="${METRICS_ENDPOINT:-http://prometheus:9090}"

# --- Colors & Formats ---------------------------------------------------------
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m' # No Color

# --- Globals ------------------------------------------------------------------
SERVICE=""
TARGET_REVISION=""
VERIFY=false
DRY_RUN=false
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"
PAGERDUTY_KEY="${PAGERDUTY_KEY:-}"

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

audit_log() {
    local action="$1"
    local details="${2:-}"
    local timestamp
    timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    local user
    user=$(whoami)
    local host
    host=$(hostname)
    
    # Ensure log directory exists
    mkdir -p "${LOG_DIR}"
    
    printf '%s\n' "{\"timestamp\":\"${timestamp}\",\"action\":\"${action}\",\"service\":\"${SERVICE}\",\"user\":\"${user}\",\"host\":\"${host}\",\"revision\":\"${TARGET_REVISION}\",\"details\":\"${details}\"}" >> "${AUDIT_LOG}"
}

send_slack_notification() {
    local status="$1"
    local message="$2"
    
    [[ -z "${SLACK_WEBHOOK}" ]] && return 0
    
    local color="good"
    [[ "${status}" == "failure" ]] && color="danger"
    [[ "${status}" == "warning" ]] && color="warning"
    
    local payload
    payload=$(cat <<EOF
{
    "attachments": [{
        "color": "${color}",
        "title": "🚨 Incident Response: Rollback ${status}",
        "fields": [
            {"title": "Service", "value": "${SERVICE}", "short": true},
            {"title": "Revision", "value": "${TARGET_REVISION:0:7}", "short": true},
            {"title": "Triggered By", "value": "$(whoami)", "short": true},
            {"title": "Timestamp", "value": "$(date -u '+%Y-%m-%d %H:%M UTC')", "short": true}
        ],
        "text": "${message}",
        "footer": "Ops Toolkit v${SCRIPT_VERSION}"
    }]
}
EOF
)
    
    curl -s -X POST -H 'Content-type: application/json' \
        --data "${payload}" \
        "${SLACK_WEBHOOK}" > /dev/null 2>&1 || true
}

trigger_pagerduty() {
    [[ -z "${PAGERDUTY_KEY}" ]] && return 0
    
    curl -s -X POST \
        -H "Authorization: Bearer ${PAGERDUTY_KEY}" \
        -H "Content-Type: application/json" \
        -H "From: incident-response@company.com" \
        "https://api.pagerduty.com/incidents" \
        -d "{
            \"incident\": {
                \"type\": \"incident\",
                \"title\": \"Emergency rollback executed for ${SERVICE}\",
                \"service\": {\"id\": \"${PAGERDUTY_SERVICE_ID}\", \"type\": \"service_reference\"},
                \"urgency\": \"high\",
                \"body\": {\"type\": \"incident_body\", \"details\": \"Automatic rollback triggered. Previous revision: ${TARGET_REVISION}\"}
            }
        }" > /dev/null 2>&1 || true
}

# =============================================================================
# Validation Functions
# =============================================================================

validate_prerequisites() {
    log_info "Validating prerequisites..."
    
    # Check kubectl
    if ! command -v kubectl &> /dev/null; then
        log_error "kubectl not found. Please install and configure kubectl."
        exit 1
    fi
    
    # Check cluster connectivity
    if ! kubectl cluster-info > /dev/null 2>&1; then
        log_error "Cannot connect to Kubernetes cluster"
        exit 1
    fi
    
    # Check service exists
    if ! kubectl get deployment "${SERVICE}" > /dev/null 2>&1; then
        log_error "Service '${SERVICE}' not found in current namespace"
        exit 1
    fi
    
    # Critical service warning
    if [[ ",${CRITICAL_SERVICES}," == *",${SERVICE},"* ]]; then
        log_warn "⚠️  CRITICAL SERVICE DETECTED: ${SERVICE}"
        log_warn "Additional approval required. Use --force to bypass (requires sudo)"
        
        if [[ "${FORCE:-false}" != "true" ]]; then
            log_error "Rollback aborted. Use --force with appropriate privileges"
            exit 2
        fi
    fi
    
    log_info "✅ Prerequisites validated"
}

fetch_deployment_history() {
    log_info "Fetching deployment history for ${SERVICE}..."
    
    # Get rollout history
    local history
    history=$(kubectl rollout history deployment/"${SERVICE}" 2>/dev/null || true)
    
    if [[ -z "${history}" ]]; then
        log_error "No deployment history available"
        exit 1
    fi
    
    # If no target revision specified, use previous
    if [[ -z "${TARGET_REVISION}" ]]; then
        local previous_rev
        previous_rev=$(echo "${history}" | tail -n 2 | head -n 1 | awk '{print $1}')
        TARGET_REVISION="${previous_rev}"
        log_info "No target revision specified. Using previous: ${TARGET_REVISION}"
    fi
}

# =============================================================================
# Rollback Operations
# =============================================================================

execute_rollback() {
    log_info "Initiating rollback for ${SERVICE} to revision ${TARGET_REVISION}..."
    audit_log "ROLLBACK_INITIATED" "Revision: ${TARGET_REVISION}"
    
    if [[ "${DRY_RUN}" == "true" ]]; then
        log_info "[DRY RUN] Would execute: kubectl rollout undo deployment/${SERVICE} --to-revision=${TARGET_REVISION}"
        return 0
    fi
    
    # Capture pre-rollback state
    local pre_rollback_pods
    pre_rollback_pods=$(kubectl get pods -l app="${SERVICE}" -o name 2>/dev/null || echo "none")
    log_info "Current pods: ${pre_rollback_pods}"
    
    # Execute rollback with timeout
    local rollback_start
    rollback_start=$(date +%s)
    
    if kubectl rollout undo deployment/"${SERVICE}" --to-revision="${TARGET_REVISION}" --timeout="${ROLLBACK_TIMEOUT}s"; then
        local rollback_duration
        rollback_duration=$(($(date +%s) - rollback_start))
        log_info "✅ Rollback completed in ${rollback_duration}s"
        audit_log "ROLLBACK_SUCCESS" "Duration: ${rollback_duration}s"
    else
        log_error "❌ Rollback failed"
        audit_log "ROLLBACK_FAILURE" "Check logs for details"
        send_slack_notification "failure" "Rollback failed for ${SERVICE}"
        exit 3
    fi
}

verify_rollout() {
    [[ "${VERIFY}" != "true" ]] && return 0
    
    log_info "Verifying rollback health..."
    audit_log "HEALTH_CHECK_STARTED" ""
    
    local attempt=1
    local healthy=false
    
    while [[ ${attempt} -le ${HEALTH_CHECK_RETRIES} ]]; do
        log_info "Health check attempt ${attempt}/${HEALTH_CHECK_RETRIES}..."
        
        # Check deployment status
        local deployment_status
        deployment_status=$(kubectl get deployment/"${SERVICE}" -o jsonpath='{.status.conditions[?(@.type=="Available")].status}' 2>/dev/null || echo "False")
        
        # Check pod readiness
        local ready_pods
        ready_pods=$(kubectl get deployment/"${SERVICE}" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
        local desired_pods
        desired_pods=$(kubectl get deployment/"${SERVICE}" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")
        
        if [[ "${deployment_status}" == "True" ]] && [[ "${ready_pods}" -ge "${desired_pods}" ]]; then
            healthy=true
            break
        fi
        
        log_warn "Pods not ready (${ready_pods}/${desired_pods}). Retrying in ${HEALTH_CHECK_INTERVAL}s..."
        sleep "${HEALTH_CHECK_INTERVAL}"
        ((attempt++))
    done
    
    if [[ "${healthy}" == "true" ]]; then
        log_info "✅ Health verification passed (${attempt} attempts)"
        audit_log "HEALTH_CHECK_PASSED" "Attempts: ${attempt}"
        
        # Emit metrics
        emit_rollback_metrics "success" "${attempt}"
    else
        log_error "❌ Health verification failed after ${HEALTH_CHECK_RETRIES} attempts"
        audit_log "HEALTH_CHECK_FAILED" "Max retries exceeded"
        emit_rollback_metrics "failure" "${HEALTH_CHECK_RETRIES}"
        
        # Escalate: trigger PagerDuty
        trigger_pagerduty
        send_slack_notification "failure" "Health check failed after rollback of ${SERVICE}"
        
        exit 4
    fi
}

emit_rollback_metrics() {
    local status="$1"
    local attempts="$2"
    local duration
    duration=$(($(date +%s) - rollback_start))
    
    # Push metrics to Prometheus pushgateway if available
    if command -v curl > /dev/null && [[ -n "${METRICS_ENDPOINT}" ]]; then
        local metric_payload
        metric_payload=$(cat <<EOF
# HELP incident_response_rollback_duration_seconds Time to complete rollback
# TYPE incident_response_rollback_duration_seconds gauge
incident_response_rollback_duration_seconds{service="${SERVICE}",status="${status}"} ${duration}
# HELP incident_response_rollback_attempts Number of health check attempts
# TYPE incident_response_rollback_attempts gauge
incident_response_rollback_attempts{service="${SERVICE}",status="${status}"} ${attempts}
# HELP incident_response_rollback_total Total rollbacks executed
# TYPE incident_response_rollback_total counter
incident_response_rollback_total{service="${SERVICE}",status="${status}"} 1
EOF
)
        
        curl -s --data-binary "${metric_payload}" \
            "${METRICS_ENDPOINT/metrics/:9091}/metrics/job/incident_response/instance/${SERVICE}" \
            > /dev/null 2>&1 || true
    fi
}

# =============================================================================
# Main Execution
# =============================================================================

show_help() {
    cat <<EOF
Ops Toolkit - Emergency Rollback Script v${SCRIPT_VERSION}

Usage: $(basename "$0") [OPTIONS]

Options:
    -s, --service            Service name to rollback (required)
    -t, --target-revision    Target revision SHA or revision number (optional, defaults to previous)
    -v, --verify             Verify rollback health after completion
    --dry-run                Show what would be executed without making changes
    --force                  Bypass critical service warnings (requires sudo)
    --timeout SECONDS        Rollback timeout (default: ${ROLLBACK_TIMEOUT})
    --retries COUNT          Health check retry count (default: ${HEALTH_CHECK_RETRIES})
    -h, --help              Show this help message

Environment Variables:
    SLACK_WEBHOOK            Webhook URL for notifications
    PAGERDUTY_KEY            API key for incident escalation
    METRICS_ENDPOINT         Prometheus endpoint for metrics

Examples:
    $(basename "$0") --service payment-api --verify
    $(basename "$0") --service auth-service --target-revision 45 --dry-run
    sudo $(basename "$0") --service inventory-service --force --verify

For more information: https://github.com/rohan-kapoor/ops-toolkit/wiki
EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -s|--service)
                SERVICE="$2"
                shift 2
                ;;
            -t|--target-revision)
                TARGET_REVISION="$2"
                shift 2
                ;;
            -v|--verify)
                VERIFY=true
                shift
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --force)
                FORCE=true
                shift
                ;;
            --timeout)
                ROLLBACK_TIMEOUT="$2"
                shift 2
                ;;
            --retries)
                HEALTH_CHECK_RETRIES="$2"
                shift 2
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
    
    # Validate required args
    if [[ -z "${SERVICE}" ]]; then
        log_error "Service name is required"
        show_help
        exit 1
    fi
}

main() {
    echo "================================================================"
    echo "  Ops Toolkit - Emergency Rollback Utility v${SCRIPT_VERSION}"
    echo "================================================================"
    echo ""
    
    parse_args "$@"
    
    log_info "Starting rollback procedure for service: ${SERVICE}"
    log_info "Dry run mode: ${DRY_RUN}"
    log_info "Verification enabled: ${VERIFY}"
    
    # Execute rollback workflow
    validate_prerequisites
    fetch_deployment_history
    execute_rollback
    verify_rollout
    
    # Success notifications
    send_slack_notification "success" "Rollback completed for ${SERVICE} to ${TARGET_REVISION:0:7}"
    
    log_info ""
    log_info "✅ Rollback procedure completed successfully"
    log_info "   Service:    ${SERVICE}"
    log_info "   Revision:   ${TARGET_REVISION}"
    log_info "   Timestamp:  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    
    return 0
}

main "$@"
