# Data Governance Matrix

| Class | Retention | Access Scope | Legal Hold | Deletion SLA | Owner |
|---|---|---|---|---|---|
| public_receipts | 365d | operators | no | 30d | ops |
| sensitive_runtime | 90d | security | yes | 7d | security |
| training_candidates | 180d | autonomy + legal-approved | yes | 14d | data_plane |
| secrets | rotated (no long-term storage) | secret_broker_only | yes | immediate revoke | security |

