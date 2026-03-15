# Ops Toolkit

**Maintained by:** Platform Operations Team  
**Owner:** Rohan Kapoor (VP Platform & Operations)  
**Last Updated:** 2026-03-14

---

## Overview

The Ops Toolkit is a collection of scripts, runbooks, and automation utilities designed to streamline platform operations for the Protheus infrastructure. This repository serves as the central source of truth for operational procedures, incident response playbooks, and infrastructure automation.

## Repository Structure

```
ops-toolkit/
├── incident-response/      # Emergency response scripts and procedures
│   └── auto-rollback.sh   # Kubernetes deployment rollback utility
├── runbooks/              # Operational runbooks and procedures
│   └── deployment-verification.md
├── monitoring/            # Monitoring configuration and dashboards
│   └── dashboards/
├── terraform/             # Infrastructure as Code modules
│   └── modules/
├── scripts/               # Utility scripts
│   └── utils/
└── github-actions/        # Reusable GitHub Actions workflows
```

## Quick Start

### Prerequisites

- kubectl v1.28+
- bash 4.0+
- aws-cli (for S3 operations)
- terraform 1.5+ (for infrastructure modules)

### Installation

```bash
# Clone the repository
git clone https://github.com/rohan-kapoor/ops-toolkit.git
cd ops-toolkit

# Make scripts executable
chmod +x incident-response/*.sh
chmod +x tests/tooling/scripts/utils/*.sh

# Verify installation
./incident-response/auto-rollback.sh --help
```

## Key Components

### Incident Response

The `incident-response/` directory contains tools for emergency situations:

- **auto-rollback.sh** - Automated Kubernetes deployment rollback with health verification
  - Sub-60-second recovery time for critical services
  - Integrated Slack and PagerDuty notifications
  - Comprehensive audit logging

### Runbooks

Standardized procedures for common operational tasks:

- **deployment-verification.md** - Post-deployment validation checklist
- More runbooks coming soon...

### Scripts & Utilities

Operational utilities for day-to-day tasks:

- **log-rotation.sh** - Automated log management with S3 archival
  - Configurable retention policies
  - Compression and cleanup
  - Kubernetes CronJob compatible

## Usage Examples

### Emergency Rollback

```bash
# Rollback to previous revision with verification
./incident-response/auto-rollback.sh --service payment-api --verify

# Rollback to specific revision (dry run)
./incident-response/auto-rollback.sh --service auth-service --target-revision 45 --dry-run
```

### Log Rotation

```bash
# Rotate logs for all services
./tests/tooling/scripts/utils/log-rotation.sh --retention-days 30

# Rotate specific service logs with S3 upload
./tests/tooling/scripts/utils/log-rotation.sh --service payment-api --s3-upload
```

## Contributing

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Make your changes with appropriate tests
3. Update documentation as needed
4. Submit a pull request for review

### Commit Message Guidelines

- Use present tense ("Add feature" not "Added feature")
- Use imperative mood ("Move cursor to..." not "Moves cursor to...")
- Limit first line to 72 characters
- Reference issues and pull requests liberally

## Security

- All scripts follow the principle of least privilege
- Sensitive operations require additional approval for critical services
- Audit logs are maintained for all incident response actions
- See [SECURITY.md](./SECURITY.md) for vulnerability reporting

## Support

- **Slack:** #platform-operations
- **Email:** platform-ops@example.com
- **On-Call:** PagerDuty rotation "Platform Operations"

## License

MIT License - See [LICENSE](./LICENSE) for details

---

*For internal Protheus use. Not for redistribution without approval.*
