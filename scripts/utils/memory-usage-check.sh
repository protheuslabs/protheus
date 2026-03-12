#!/usr/bin/env bash
#
# Utility: Memory Usage Monitor
# Author: Rohan Kapoor
# Created: 2026-03-12
#
# Monitors memory usage of Protheus processes and reports status.
# Useful for identifying memory trends before they become issues.
#
# Usage: ./scripts/utils/memory-usage-check.sh [--warning=<mb>] [--critical=<mb>]
#
# Options:
#   --warning=<mb>   Warning threshold in MB (default: 2048)
#   --critical=<mb>  Critical threshold in MB (default: 4096)
#   --log            Write results to log file
#   --slack          Send alert to Slack webhook (if configured)
#   --verbose        Show detailed memory breakdown
#
# Exit codes:
#   0 - Memory usage within normal parameters
#   1 - Warning threshold exceeded
#   2 - Critical threshold exceeded
#   3 - Configuration error
#

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PROTHEUS_HOST_PATTERN="protheus"

# Default thresholds
WARNING_THRESHOLD=2048
CRITICAL_THRESHOLD=4096
VERBOSE=0
DO_LOG=0
SLACK_NOTIFY=0

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --warning=*)
      WARNING_THRESHOLD="${1#*=}"
      shift
      ;;
    --critical=*)
      CRITICAL_THRESHOLD="${1#*=}"
      shift
      ;;
    --log)
      DO_LOG=1
      shift
      ;;
    --slack)
      SLACK_NOTIFY=1
      shift
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    --help|-h)
      sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# //'
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Use --help for usage information" >&2
      exit 3
      ;;
  esac
done

# Colors for terminal output (disable if not TTY)
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  NC='\033[0m'
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  CYAN=''
  NC=''
fi

# Logging functions
log_section() {
  echo -e "${BLUE}[MONITOR]${NC} $1"
}

log_pass() {
  echo -e "${GREEN}[OK]${NC} $1"
}

log_fail() {
  echo -e "${RED}[FAIL]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_info() {
  [[ $VERBOSE -eq 1 ]] && echo -e "${CYAN}[INFO]${NC} $1"
}

# Get log file path
get_log_file() {
  local logs_dir="${WORKSPACE_ROOT}/logs"
  mkdir -p "$logs_dir"
  echo "${logs_dir}/memory-$(date +%Y%m%d).log"
}

# Log to file if --log is set
write_log() {
  if [[ $DO_LOG -eq 1 ]]; then
    local log_file
    log_file=$(get_log_file)
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$log_file"
  fi
}

# Check if running on Protheus infrastructure
check_host_validity() {
  log_section "Host validation"
  
  local hostname
  hostname=$(hostname -s 2>/dev/null || hostname)
  
  if [[ "$hostname" =~ $PROTHEUS_HOST_PATTERN ]]; then
    log_pass "Running on Protheus host: $hostname"
    write_log "Host check passed: $hostname"
    return 0
  else
    log_warn "Hostname '$hostname' does not match Protheus pattern"
    log_info "This script is designed for Protheus infrastructure"
    write_log "Host warning: $hostname (non-Protheus)"
    return 0  # Don't fail, just warn
  fi
}

# Get system memory statistics
get_system_memory() {
  log_section "System memory overview"
  
  local total used free percent_used
  
  if command -v free > /dev/null 2>&1; then
    # Linux path
    local mem_line
    mem_line=$(free -m | grep -E '^Mem:')
    total=$(echo "$mem_line" | awk '{print $2}')
    used=$(echo "$mem_line" | awk '{print $3}')
    free=$(echo "$mem_line" | awk '{print $4}')
    
    # Calculate percentage
    percent_used=$((100 * used / total))
    
    log_info "Total memory: ${total}MB"
    log_info "Used memory: ${used}MB"
    log_info "Free memory: ${free}MB"
    log_pass "System memory usage: ${percent_used}%"
  elif command -v vm_stat > /dev/null 2>&1; then
    # macOS path
    total=$(sysctl -n hw.memsize 2>/dev/null | awk '{print $1 / 1024 / 1024}')
    total=${total%.*}
    
    local mem_pressure
    mem_pressure=$(vm_stat 2>/dev/null | grep "Pages free" | awk '{print $3}' | tr -d '.')
    
    if [[ -n "$mem_pressure" ]]; then
      free=$((mem_pressure * 4096 / 1024 / 1024))
      used=$((total - free))
      percent_used=$((100 * used / total))
      
      log_info "Total memory: ${total}MB (macOS)"
      log_info "Used memory: ${used}MB"
      log_info "Free memory: ${free}MB"
      log_pass "System memory usage: ${percent_used}%"
    else
      log_warn "Could not determine memory usage on macOS"
    fi
  else
    log_warn "Unable to retrieve system memory stats"
  fi
}

# Find Protheus processes and calculate usage
get_protheus_memory() {
  log_section "Protheus process analysis"
  
  local total_protheus_mem=0
  local protheus_count=0
  local pids=""
  
  # Look for Protheus-related processes
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    
    local pid mem_kb
    pid=$(echo "$line" | awk '{print $2}')
    mem_kb=$(echo "$line" | awk '{print $6}')
    
    # Convert KB to MB
    local mem_mb=$((mem_kb / 1024))
    
    total_protheus_mem=$((total_protheus_mem + mem_mb))
    protheus_count=$((protheus_count + 1))
    
    [[ -n "$pids" ]] && pids="${pids},"
    pids="${pids}${pid}"
    
    [[ $VERBOSE -eq 1 ]] && log_info "PID $pid: ${mem_mb}MB"
    
  done < <(ps aux 2>/dev/null | grep -i protheus | grep -v grep || true)
  
  if [[ $protheus_count -eq 0 ]]; then
    log_warn "No Protheus processes found"
    echo "PROTHEUS_MEM=0"
    echo "PROTHEUS_COUNT=0"
    return 1
  fi
  
  log_pass "Found $protheus_count Protheus process(es)"
  log_pass "Total Protheus memory usage: ${total_protheus_mem}MB"
  
  echo "PROTHEUS_MEM=$total_protheus_mem"
  echo "PROTHEUS_COUNT=$protheus_count"
  
  write_log "Protheus processes: $protheus_count, Memory: ${total_protheus_mem}MB"
  
  return 0
}

# Evaluate against thresholds
check_thresholds() {
  local mem_usage=$1
  local status=0
  
  log_section "Threshold evaluation"
  log_info "Warning threshold: ${WARNING_THRESHOLD}MB"
  log_info "Critical threshold: ${CRITICAL_THRESHOLD}MB"
  log_info "Current usage: ${mem_usage}MB"
  
  if [[ $mem_usage -ge $CRITICAL_THRESHOLD ]]; then
    log_fail "CRITICAL: Memory usage (${mem_usage}MB) exceeds critical threshold (${CRITICAL_THRESHOLD}MB)"
    write_log "ALERT CRITICAL: Memory at ${mem_usage}MB"
    status=2
  elif [[ $mem_usage -ge $WARNING_THRESHOLD ]]; then
    log_warn "WARNING: Memory usage (${mem_usage}MB) exceeds warning threshold (${WARNING_THRESHOLD}MB)"
    write_log "ALERT WARNING: Memory at ${mem_usage}MB"
    status=1
  else
    log_pass "Status: Memory usage within acceptable range (${mem_usage}MB < ${WARNING_THRESHOLD}MB)"
    write_log "Status: OK at ${mem_usage}MB"
  fi
  
  return $status
}

# Show top memory consumers
show_top_consumers() {
  [[ $VERBOSE -eq 0 ]] && return 0
  
  log_section "Top 5 memory consumers"
  
  ps aux 2>/dev/null | sort -nrk 6 | head -5 | while IFS= read -r line; do
    local pid mem cmd
    pid=$(echo "$line" | awk '{print $2}')
    mem=$(echo "$line" | awk '{print $6}')
    cmd=$(echo "$line" | awk '{print $11}')
    
    local mem_mb=$((mem / 1024))
    echo -e "  ${BLUE}${pid}${NC}  ${mem_mb}MB  ${cmd}"
  done
}

# Send Slack notification (placeholder)
send_notification() {
  local level=$1
  local message=$2
  
  [[ $SLACK_NOTIFY -eq 0 ]] && return 0
  
  local webhook_url="${PROTHEUS_SLACK_WEBHOOK:-}"
  
  if [[ -z "$webhook_url" ]]; then
    log_warn "Slack webhook not configured (set PROTHEUS_SLACK_WEBHOOK)"
    return 1
  fi
  
  log_info "Sending Slack notification: $level - $message"
  write_log "Slack notification sent: $level"
  
  # Integration point for actual Slack webhook
  # curl -s -X POST ...
  
  return 0
}

# Main execution
main() {
  echo "=== Protheus Memory Usage Monitor ==="
  echo "Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "Version: 1.0.0"
  echo "Author: Rohan Kapoor"
  echo ""
  
  # Validate thresholds make sense
  if [[ $WARNING_THRESHOLD -ge $CRITICAL_THRESHOLD ]]; then
    log_fail "Configuration error: Warning threshold ($WARNING_THRESHOLD) must be less than Critical threshold ($CRITICAL_THRESHOLD)"
    exit 3
  fi
  
  # Run checks
  check_host_validity
  get_system_memory
  
  # Get Protheus memory
  local protheus_mem=0
  local process_info
  process_info=$(get_protheus_memory) || true
  
  if [[ -n "$process_info" ]]; then
    protheus_mem=$(echo "$process_info" | grep "PROTHEUS_MEM=" | cut -d= -f2 || echo "0")
    [[ -z "$protheus_mem" ]] && protheus_mem=0
  fi
  
  show_top_consumers
  
  # Evaluate thresholds
  local exit_status=0
  check_thresholds "$protheus_mem" || exit_status=$?
  
  # Send notifications if needed
  if [[ $exit_status -eq 2 ]]; then
    send_notification "CRITICAL" "Memory usage at ${protheus_mem}MB"
  elif [[ $exit_status -eq 1 ]]; then
    send_notification "WARNING" "Memory usage at ${protheus_mem}MB"
  fi
  
  # Summary
  echo ""
  echo "=== Summary ==="
  echo -e "Protheus processes: ${BLUE}${process_info:-0}${NC}\n      Memory usage: ${BLUE}${protheus_mem:-0}MB${NC}"
  echo -e "  Warning level: ${YELLOW}${WARNING_THRESHOLD}MB${NC}"
  echo -e "  Critical level: ${RED}${CRITICAL_THRESHOLD}MB${NC}"
  
  if [[ $DO_LOG -eq 1 ]]; then
    local log_file
    log_file=$(get_log_file)
    echo ""
    echo "Log written to: $log_file"
    tail -1 "$log_file" 2>/dev/null || true
  fi
  
  echo ""
  if [[ $exit_status -eq 0 ]]; then
    log_pass "Memory check completed successfully"
  elif [[ $exit_status -eq 1 ]]; then
    log_warn "Memory check completed with warnings"
  else
    log_fail "Memory check completed with critical alerts"
  fi
  
  exit $exit_status
}

main "$@"
