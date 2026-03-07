# Environment Matrix

| Env | Owners | Allowed Mutations | Approval Requirements | Deploy Gates |
|---|---|---|---|---|
| dev | platform | any shadow-safe | single maintainer | contract_check + unit tests |
| stage | platform + ops | bounded canary/live | dual approval for high-risk | foundation_contract_gate + reliability checks |
| prod | ops + governance | policy-approved only | explicit high-risk approval + soul-token gate | all required checks + no freeze gate violations |

