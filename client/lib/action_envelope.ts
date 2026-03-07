const crypto = require('crypto');

const ACTION_TYPES = {
  RESEARCH: 'research',
  CODE_CHANGE: 'code_change',
  PUBLISH_PUBLICLY: 'publish_publicly',
  SPEND_MONEY: 'spend_money',
  CHANGE_CREDENTIALS: 'change_credentials',
  DELETE_DATA: 'delete_data',
  OUTBOUND_CONTACT_NEW: 'outbound_contact_new',
  OUTBOUND_CONTACT_EXISTING: 'outbound_contact_existing',
  DEPLOYMENT: 'deployment',
  OTHER: 'other'
} as const;

const RISK_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high'
} as const;

type ActionType = typeof ACTION_TYPES[keyof typeof ACTION_TYPES];
type RiskLevel = typeof RISK_LEVELS[keyof typeof RISK_LEVELS];

const HIGH_STAKES_PATTERNS: Record<string, RegExp[]> = {
  spend_money: [
    /purchase/i,
    /buy/i,
    /subscribe/i,
    /payment/i,
    /\$\d+/,
    /\d+\s*(USD|EUR|GBP)/i
  ],
  publish_publicly: [
    /post\s+to/i,
    /publish/i,
    /tweet/i,
    /moltbook.*create/i,
    /blog/i,
    /medium/i,
    /github.*push/i
  ],
  change_credentials: [
    /password/i,
    /api_key/i,
    /token/i,
    /credential/i,
    /auth/i,
    /secret/i,
    /rotate/i
  ],
  delete_data: [
    /rm\s+-rf/i,
    /delete/i,
    /drop\s+table/i,
    /destroy/i,
    /reset/i,
    /truncate/i
  ],
  outbound_contact_new: [
    /send.*email/i,
    /email.*to/i,
    /message.*new/i,
    /contact.*@/i,
    /reach.out/i
  ],
  deployment: [
    /deploy/i,
    /release/i,
    /production/i,
    /prod/i,
    /go.*live/i
  ]
};

const LOW_RISK_PATTERNS: RegExp[] = [
  /read/i,
  /list/i,
  /get/i,
  /fetch/i,
  /search/i,
  /grep/i,
  /cat\s+/i,
  /ls\s+/i,
  /echo/i,
  /test/i,
  /benchmark/i
];

type CreateActionEnvelopeInput = {
  directive_id?: string | null;
  tier?: number;
  type?: ActionType;
  summary: string;
  risk?: RiskLevel;
  payload?: Record<string, unknown>;
  tags?: string[];
  toolName?: string | null;
  commandText?: string | null;
};

type ActionEnvelope = {
  action_id: string;
  directive_id: string | null;
  tier: number;
  type: ActionType;
  summary: string;
  risk: RiskLevel;
  payload: Record<string, unknown>;
  tags: string[];
  metadata: {
    created_at: string;
    tool_name: string | null;
    command_text: string | null;
    requires_approval: boolean;
    allowed: boolean;
    blocked_reason: string | null;
  };
};

type Classification = {
  type: ActionType;
  risk: RiskLevel;
  confidence: 'low' | 'medium' | 'high';
  matched_pattern: string | null;
};

function createActionEnvelope({
  directive_id = null,
  tier = 2,
  type = ACTION_TYPES.OTHER,
  summary,
  risk = RISK_LEVELS.LOW,
  payload = {},
  tags = [],
  toolName = null,
  commandText = null
}: CreateActionEnvelopeInput): ActionEnvelope {
  const actionId = generateActionId();

  return {
    action_id: actionId,
    directive_id,
    tier,
    type,
    summary,
    risk,
    payload,
    tags,
    metadata: {
      created_at: new Date().toISOString(),
      tool_name: toolName,
      command_text: commandText,
      requires_approval: false,
      allowed: true,
      blocked_reason: null
    }
  };
}

function generateActionId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `act_${timestamp}_${random}`;
}

function classifyAction({ toolName, commandText }: { toolName?: string | null; commandText?: string | null; payload?: Record<string, unknown> }): Classification {
  const text = `${toolName || ''} ${commandText || ''}`.toLowerCase();

  for (const [type, patterns] of Object.entries(HIGH_STAKES_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return {
          type: (ACTION_TYPES as Record<string, ActionType>)[type.toUpperCase()] || ACTION_TYPES.OTHER,
          risk: RISK_LEVELS.HIGH,
          confidence: 'medium',
          matched_pattern: pattern.toString()
        };
      }
    }
  }

  for (const pattern of LOW_RISK_PATTERNS) {
    if (pattern.test(text)) {
      return {
        type: ACTION_TYPES.RESEARCH,
        risk: RISK_LEVELS.LOW,
        confidence: 'low',
        matched_pattern: pattern.toString()
      };
    }
  }

  return {
    type: ACTION_TYPES.OTHER,
    risk: RISK_LEVELS.MEDIUM,
    confidence: 'low',
    matched_pattern: null
  };
}

function requiresApprovalByDefault(type: ActionType): boolean {
  const approvalRequiredTypes: ActionType[] = [
    ACTION_TYPES.PUBLISH_PUBLICLY,
    ACTION_TYPES.SPEND_MONEY,
    ACTION_TYPES.CHANGE_CREDENTIALS,
    ACTION_TYPES.DELETE_DATA,
    ACTION_TYPES.OUTBOUND_CONTACT_NEW,
    ACTION_TYPES.DEPLOYMENT
  ];

  return approvalRequiredTypes.includes(type);
}

function detectIrreversible(commandText: string): { is_irreversible: boolean; pattern?: string; severity?: 'critical' } {
  const irreversiblePatterns: RegExp[] = [
    /rm\s+-rf/i,
    /rm\s+.*\/\*/i,
    /drop\s+database/i,
    /drop\s+table/i,
    /truncate.*table/i,
    /delete.*where/i,
    /destroy/i,
    /reset\s+--hard/i,
    /git\s+clean\s+-fd/i
  ];

  for (const pattern of irreversiblePatterns) {
    if (pattern.test(commandText)) {
      return {
        is_irreversible: true,
        pattern: pattern.toString(),
        severity: 'critical'
      };
    }
  }

  return { is_irreversible: false };
}

function autoClassifyAndCreate({ toolName, commandText, payload = {}, summary = null }: { toolName?: string | null; commandText?: string | null; payload?: Record<string, unknown>; summary?: string | null }): ActionEnvelope {
  const classification = classifyAction({ toolName, commandText, payload });
  const autoSummary = summary || generateSummary(toolName, commandText, classification.type);

  return createActionEnvelope({
    type: classification.type,
    risk: classification.risk,
    summary: autoSummary,
    toolName,
    commandText,
    payload,
    tags: [classification.type, classification.risk]
  });
}

function generateSummary(toolName: string | null | undefined, commandText: string | null | undefined, type: ActionType): string {
  if (toolName && commandText) {
    return `${type}: ${toolName} - ${commandText.substring(0, 50)}${commandText.length > 50 ? '...' : ''}`;
  } else if (toolName) {
    return `${type}: ${toolName}`;
  } else if (commandText) {
    return `${type}: ${commandText.substring(0, 60)}${commandText.length > 60 ? '...' : ''}`;
  }
  return `${type}: Unnamed action`;
}

export {
  ACTION_TYPES,
  RISK_LEVELS,
  createActionEnvelope,
  classifyAction,
  autoClassifyAndCreate,
  requiresApprovalByDefault,
  detectIrreversible,
  generateActionId
};
