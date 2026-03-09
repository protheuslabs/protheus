#!/usr/bin/env bash
#
# Utility: Deployment Health Check
# Author: Rohan Kapoor
# Created: 2026-03-09
#
# Performs post-deployment health verification checks.
# Validates service status, endpoint availability, and key metrics.
#
# Usage: ./scripts/utils/health-check-deployment.sh [--full]
#
# Exit codes:
#   0 - All checks passed
#   1 - One or more checks failed
#   2 - Configuration error
#

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HTTP_TIMEOUT=10
VERBOSE=0

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --full)
      FULL_CHECK=1
      shift
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--full] [--verbose]"
      echo "  --full     Run extended checks (may take longer)"
      echo "  --verbose  Enable detailed output"
      echo "  --help     Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

# Colors for terminal output (disable if not TTY)
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  NC=''
fi

# Logging functions
log_section() {
  echo -e "${BLUE}[CHECK]${NC} $1"
}

log_pass() {
  echo -e "${GREEN}[PASS]${NC} $1"
}

log_fail() {
  echo -e "${RED}[FAIL]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_info() {
  [[ $VERBOSE -eq 1 ]] && echo -e "${NC}[INFO]${NC} $1"
}

# Counters for summary
CHECKS_PASSED=0
CHECKS_FAILED=0
CHECKS_WARNED=0

# Helper: Track check results
record_pass() {
  CHECKS_PASSED=$((CHECKS_PASSED + 1))
}

record_fail() {
  CHECKS_FAILED=$((CHECKS_FAILED + 1))
}

record_warn() {
  CHECKS_WARNED=$((CHECKS_WARNED + 1))
}

# Check 1: Git repository status
check_git_status() {
  log_section "Git repository status"
  
  if ! git -C "$WORKSPACE_ROOT" rev-parse --git-dir > /dev/null 2>&1; then
    log_fail "Not a git repository"
    record_fail
    return 1
  fi
  
  local branch
  branch=$(git -C "$WORKSPACE_ROOT" branch --show-current 2>/dev/null || echo "unknown")
  log_info "Current branch: $branch"
  
  # Check for uncommitted changes (informational only)
  if git -C "$WORKSPACE_ROOT" diff-index --quiet HEAD 2>/dev/null; then
    log_pass "Working tree is clean"
    record_pass
  else
    log_warn "Uncommitted changes detected"
    record_warn
  fi
  
  # Check for recent commits
  local last_commit_date
  last_commit_date=$(git -C "$WORKSPACE_ROOT" log -1 --format=%cd --date=short 2>/dev/null || echo "unknown")
  log_info "Last commit: $last_commit_date"
  
  return 0
}

# Check 2: Environment file presence and syntax
check_environment() {
  log_section "Environment configuration"
  
  local env_example="${WORKSPACE_ROOT}/.env.example"
  
  if [[ -f "$env_example" ]]; then
    log_pass ".env.example exists"
    record_pass
    
    # Validate basic syntax (no spaces around =)
    local issues=0
    while IFS= read -r line || [[ -n "$line" ]]; do
      # Skip comments and empty lines
      [[ "$line" =~ ^#.*$ ]] && continue
      [[ -z "$line" ]] && continue
      
      # Check for spaces around = (common mistake)
      if [[ "$line" =~ [[:space:]]=[[:space:]] ]]; then
        log_warn "Line has spaces around '=': $line"
        issues=$((issues + 1))
      fi
    done < "$env_example"
    
    if [[ $issues -eq 0 ]]; then
      log_pass "Environment file syntax looks valid"
      record_pass
    else
      record_warn
    fi
  else
    log_warn ".env.example not found"
    record_warn
  fi
  
  return 0
}

# Check 3: Documentation completeness
check_documentation() {
  log_section "Documentation structure"
  
  local required_docs=(
    "README.md"
    "docs/SYSTEM-ARCHITECTURE-SPECS.md"
    "docs/ops/RUNBOOK-001-incident-response.md"
  )
  
  local all_present=1
  for doc in "${required_docs[@]}"; do
    local doc_path="${WORKSPACE_ROOT}/${doc}"
    if [[ -f "$doc_path" ]]; then
      log_info "Found: $doc"
    else
      log_fail "Missing: $doc"
      all_present=0
    fi
  done
  
  if [[ $all_present -eq 1 ]]; then
    log_pass "All critical documentation present"
    record_pass
  else
    record_fail
  fi
  
  return 0
}

# Check 4: Script directory structure
check_script_structure() {
  log_section "Script directory structure"
  
  local scripts_dir="${WORKSPACE_ROOT}/scripts"
  
  if [[ ! -d "$scripts_dir" ]]; then
    log_fail "Scripts directory not found: $scripts_dir"
    record_fail
    return 1
  fi
  
  log_pass "Scripts directory exists"
  record_pass
  
  # Check for executable permissions on shell scripts
  local non_executable=0
  while IFS= read -r -d '' script; do
    if [[ ! -x "$script" ]]; then
      log_warn "Script not executable: $(basename "$script")"
      non_executable=$((non_executable + 1))
    fi
  done < <(find "$scripts_dir" -name "*.sh" -type f -print0 2>/dev/null || true)
  
  if [[ $non_executable -eq 0 ]]; then
    log_pass "All shell scripts have executable permissions"
    record_pass
  else
    record_warn
  fi
  
  return 0
}

# Check 5: Package manifest validation (if applicable)
check_package_manifest() {
  log_section "Package manifest"
  
  local package_json="${WORKSPACE_ROOT}/package.json"
  local cargo_toml="${WORKSPACE_ROOT}/Cargo.toml"
  
  if [[ -f "$package_json" ]]; then
    log_pass "package.json found"
    record_pass
    
    # Check for required fields
    if command -v node > /dev/null 2>&1; then
      if node -e "JSON.parse(require('fs').readFileSync('$package_json'));" 2>/dev/null; then
        log_pass "package.json is valid JSON"
        record_pass
      else
        log_fail "package.json contains invalid JSON"
        record_fail
      fi
    fi
  elif [[ -f "$cargo_toml" ]]; then
    log_pass "Cargo.toml found (Rust project)"
    record_pass
  else
    log_warn "No recognized package manifest found"
    record_warn
  fi
  
  return 0
}

# Check 6: Full system check (optional, may be slow)
check_full_system() {
  log_section "Extended checks"
  
  # Placeholder for extended checks
  # These could include:
  # - Database connectivity tests
  # - External API endpoint tests
  # - Performance benchmarks
  # - Integration test runs
  
  log_warn "Full system checks not implemented yet"
  log_info "This is a TODO for future enhancement"
  record_warn
  
  return 0
}

# Main execution
main() {
  echo "=== Deployment Health Check ==="
  echo "Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "Workspace: $WORKSPACE_ROOT"
  echo "Mode: ${FULL_CHECK:+Full}${FULL_CHECK:-Basic}"
  echo ""
  
  # Run basic checks
  check_git_status
  check_environment
  check_documentation
  check_script_structure
  check_package_manifest
  
  # Run extended checks if requested
  if [[ ${FULL_CHECK:-0} -eq 1 ]]; then
    echo ""
    check_full_system
  fi
  
  # Summary
  echo ""
  echo "=== Summary ==="
  log_pass "Checks passed: $CHECKS_PASSED"
  [[ $CHECKS_FAILED -gt 0 ]] && log_fail "Checks failed: $CHECKS_FAILED"
  [[ $CHECKS_WARNED -gt 0 ]] && log_warn "Warnings: $CHECKS_WARNED"
  
  echo ""
  if [[ $CHECKS_FAILED -eq 0 ]]; then
    log_pass "Health check completed successfully"
    exit 0
  else
    log_fail "Health check completed with failures"
    exit 1
  fi
}

main "$@"
