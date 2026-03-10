#!/usr/bin/env bash
#
# Utility: Log Analysis Helper
# Author: Rohan Kapoor
# Created: 2026-03-10
#
# Analyzes log files for common patterns, errors, and trends.
# Useful for post-incident analysis and routine log auditing.
#
# Usage: ./scripts/utils/log-analyzer.sh [OPTIONS] <log-file>
#
# Options:
#   --errors-only      Show only error-level entries
#   --warnings-only    Show only warning-level entries
#   --summary          Print summary statistics only
#   --time-range       Filter by time range (format: HH:MM-HH:MM)
#   --pattern          Search for specific pattern (regex supported)
#   --top-errors       Show top N most common errors (default: 10)
#
# Exit codes:
#   0 - Analysis completed successfully
#   1 - File not found or unreadable
#   2 - Invalid options provided
#

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Default values
SHOW_ERRORS=0
SHOW_WARNINGS=0
SUMMARY_ONLY=0
TIME_RANGE=""
SEARCH_PATTERN=""
TOP_ERRORS_COUNT=10
OUTPUT_FILE=""

# Colors for terminal output (disable if not TTY or NO_COLOR set)
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  RED='\033[0;31m'
  YELLOW='\033[1;33m'
  GREEN='\033[0;32m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  NC='\033[0m'
else
  RED=''
  YELLOW=''
  GREEN=''
  BLUE=''
  CYAN=''
  NC=''
fi

# Logging functions
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_section() { echo -e "\n${CYAN}=== $1 ===${NC}"; }

# Usage information
usage() {
  cat << EOF
Usage: $(basename "$0") [OPTIONS] <log-file>

Analyze log files for patterns, errors, and statistics.

Options:
  -e, --errors-only       Show only error-level entries
  -w, --warnings-only     Show only warning-level entries
  -s, --summary           Print summary statistics only
  -t, --time-range RANGE  Filter by time range (HH:MM-HH:MM)
  -p, --pattern PATTERN   Search for specific regex pattern
  -n, --top-errors N      Show top N most common errors (default: 10)
  -o, --output FILE       Write results to file instead of stdout
  -h, --help              Show this help message

Examples:
  $(basename "$0") /var/log/protheus/app.log
  $(basename "$0") --errors-only --summary app.log
  $(basename "$0") --time-range 09:00-10:00 --pattern "timeout" app.log
  $(basename "$0") --top-errors 20 -o report.txt app.log

EOF
}

# Validate time range format
validate_time_range() {
  local range="$1"
  if [[ ! "$range" =~ ^[0-9]{2}:[0-9]{2}-[0-9]{2}:[0-9]{2}$ ]]; then
    log_error "Invalid time range format: $range"
    log_error "Expected format: HH:MM-HH:MM (e.g., 09:00-17:00)"
    return 1
  fi
  return 0
}

# Parse command line arguments
parse_args() {
  if [[ $# -eq 0 ]]; then
    usage
    exit 2
  fi

  local log_file_set=0

  while [[ $# -gt 0 ]]; do
    case $1 in
      -e|--errors-only)
        SHOW_ERRORS=1
        shift
        ;;
      -w|--warnings-only)
        SHOW_WARNINGS=1
        shift
        ;;
      -s|--summary)
        SUMMARY_ONLY=1
        shift
        ;;
      -t|--time-range)
        TIME_RANGE="$2"
        if ! validate_time_range "$TIME_RANGE"; then
          exit 2
        fi
        shift 2
        ;;
      -p|--pattern)
        SEARCH_PATTERN="$2"
        shift 2
        ;;
      -n|--top-errors)
        TOP_ERRORS_COUNT="$2"
        if ! [[ "$TOP_ERRORS_COUNT" =~ ^[0-9]+$ ]]; then
          log_error "Top errors count must be a number"
          exit 2
        fi
        shift 2
        ;;
      -o|--output)
        OUTPUT_FILE="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      -*)
        log_error "Unknown option: $1"
        usage
        exit 2
        ;;
      *)
        if [[ $log_file_set -eq 0 ]]; then
          LOG_FILE="$1"
          log_file_set=1
          shift
        else
          log_error "Multiple log files specified. Only one file is supported."
          exit 2
        fi
        ;;
    esac
  done

  if [[ $log_file_set -eq 0 ]]; then
    log_error "No log file specified"
    usage
    exit 2
  fi
}

# Validate log file
validate_log_file() {
  if [[ ! -f "$LOG_FILE" ]]; then
    log_error "Log file not found: $LOG_FILE"
    exit 1
  fi

  if [[ ! -r "$LOG_FILE" ]]; then
    log_error "Cannot read log file: $LOG_FILE"
    exit 1
  fi

  log_info "Analyzing log file: $LOG_FILE"
  log_info "File size: $(du -h "$LOG_FILE" | cut -f1)"
  log_info "Line count: $(wc -l < "$LOG_FILE" | tr -d ' ')"
}

# Count entries by level
count_by_level() {
  local level="$1"
  local pattern

  case "$level" in
    ERROR|error)
      pattern="(ERROR|Error|error)"
      ;;
    WARN|WARNING|warn|warning)
      pattern="(WARN|WARNING|Warn|Warning|warn|warning)"
      ;;
    INFO|info)
      pattern="(INFO|Info|info)"
      ;;
    DEBUG|debug)
      pattern="(DEBUG|Debug|debug)"
      ;;
    *)
      pattern="$level"
      ;;
  esac

  grep -cE "$pattern" "$LOG_FILE" 2>/dev/null || echo 0
}

# Extract timestamp from log line (best effort)
extract_timestamp() {
  local line="$1"
  # Try common timestamp formats
  echo "$line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}' | head -1 || echo "N/A"
}

# Filter by time range
filter_by_time_range() {
  local start_time="${TIME_RANGE%-*}"
  local end_time="${TIME_RANGE#*-}"

  # This is a simplified filter - adjusts based on timestamp format
  while IFS= read -r line; do
    local ts
    ts=$(extract_timestamp "$line")
    if [[ "$ts" != "N/A" ]]; then
      local time_part="${ts:11:5}"
      if [[ "$time_part" >= "$start_time" && "$time_part" <= "$end_time" ]]; then
        echo "$line"
      fi
    fi
  done < "$LOG_FILE"
}

# Generate summary statistics
generate_summary() {
  log_section "LOG ANALYSIS SUMMARY"
  echo "Log file: $LOG_FILE"
  echo "Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "Analyzed by: $(whoami)@$(hostname -s 2>/dev/null || echo 'unknown')"
  echo ""

  local total_lines
  total_lines=$(wc -l < "$LOG_FILE" | tr -d ' ')

  local error_count warn_count info_count
  error_count=$(count_by_level "ERROR")
  warn_count=$(count_by_level "WARN")
  info_count=$(count_by_level "INFO")

  printf "%-20s %10s\n" "Metric" "Count"
  printf "%-20s %10s\n" "--------" "----------"
  printf "%-20s %10d\n" "Total lines" "$total_lines"
  printf "%-20s %10d\n" "Error entries" "$error_count"
  printf "%-20s %10d\n" "Warning entries" "$warn_count"
  printf "%-20s %10d\n" "Info entries" "$info_count"

  if [[ $total_lines -gt 0 ]]; then
    local error_pct
    error_pct=$(echo "scale=2; $error_count * 100 / $total_lines" | bc 2>/dev/null || echo "N/A")
    printf "%-20s %10s%%\n" "Error rate" "$error_pct"
  fi
}

# Show error entries
show_errors() {
  log_section "ERROR ENTRIES"

  local error_patterns="(ERROR|Error|error|FATAL|Fatal|fatal|CRITICAL|Critical|critical)"
  local count=0

  while IFS= read -r line; do
    if [[ -n "$SEARCH_PATTERN" ]]; then
      if echo "$line" | grep -qE "$SEARCH_PATTERN"; then
        echo "$line"
        ((count++))
      fi
    else
      echo "$line"
      ((count++))
    fi
  done < <(grep -E "$error_patterns" "$LOG_FILE" 2>/dev/null || true)

  if [[ $count -eq 0 ]]; then
    log_info "No error entries found"
  else
    echo ""
    log_info "Total error entries shown: $count"
  fi
}

# Show warning entries
show_warnings() {
  log_section "WARNING ENTRIES"

  local warn_patterns="(WARN|WARNING|Warn|Warning|warn|warning)"
  local count=0

  while IFS= read -r line; do
    if [[ -n "$SEARCH_PATTERN" ]]; then
      if echo "$line" | grep -qE "$SEARCH_PATTERN"; then
        echo "$line"
        ((count++))
      fi
    else
      echo "$line"
      ((count++))
    fi
  done < <(grep -E "$warn_patterns" "$LOG_FILE" 2>/dev/null || true)

  if [[ $count -eq 0 ]]; then
    log_info "No warning entries found"
  else
    echo ""
    log_info "Total warning entries shown: $count"
  fi
}

# Show top recurring errors
show_top_errors() {
  log_section "TOP $TOP_ERRORS_COUNT RECURRING ERRORS"

  local error_patterns="(ERROR|Error|error|FATAL|Fatal|fatal)"
  local temp_file
  temp_file=$(mktemp)

  # Extract error messages and count occurrences
  grep -oE "$error_patterns[^\"]*" "$LOG_FILE" 2>/dev/null | \
    sed 's/^[[:space:]]*//' | \
    sort | \
    uniq -c | \
    sort -rn | \
    head -n "$TOP_ERRORS_COUNT" > "$temp_file" || true

  if [[ -s "$temp_file" ]]; then
    printf "%-8s %s\n" "Count" "Error Pattern"
    printf "%-8s %s\n" "--------" "--------------------"
    while read -r count pattern; do
      printf "%-8s %s\n" "$count" "${pattern:0:60}"
    done < "$temp_file"
  else
    log_info "No recurring error patterns found"
  fi

  rm -f "$temp_file"
}

# Main execution
main() {
  parse_args "$@"
  validate_log_file

  # Redirect output if requested
  if [[ -n "$OUTPUT_FILE" ]]; then
    exec > "$OUTPUT_FILE"
    log_info "Writing output to: $OUTPUT_FILE"
  fi

  # Generate summary first
  generate_summary

  # Show top errors if not summary-only
  if [[ $SUMMARY_ONLY -eq 0 ]]; then
    show_top_errors
  fi

  # Show filtered content based on flags
  if [[ $SUMMARY_ONLY -eq 0 ]]; then
    if [[ $SHOW_ERRORS -eq 1 ]]; then
      show_errors
    elif [[ $SHOW_WARNINGS -eq 1 ]]; then
      show_warnings
    fi
  fi

  echo ""
  log_success "Analysis complete"
}

# Handle script cleanup
cleanup() {
  # Cleanup any temp files if needed
  :
}

trap cleanup EXIT

# Run main function
main "$@"
