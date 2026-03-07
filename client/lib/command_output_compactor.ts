const toolResponseCompactor = require('./tool_response_compactor');
const { compactToolResponse } = toolResponseCompactor as { compactToolResponse: (data: string, options?: { toolName?: string }) => any };

function extractRawPathFromContent(content: unknown): string | null {
  const txt = String(content || '');
  const m = txt.match(/📁 Raw output saved to:\s*([^\n]+)/);
  return m ? String(m[1] || '').trim() : null;
}

function compactCommandOutput(rawText: unknown, toolName: unknown): {
  text: string;
  compacted: boolean;
  raw_path: string | null;
  metrics: unknown;
} {
  const result = compactToolResponse(String(rawText || ''), { toolName: String(toolName || 'command_output') });
  const rawPathFromContent = extractRawPathFromContent(result.content);
  return {
    text: String(result.content || ''),
    compacted: result.compacted === true,
    raw_path: rawPathFromContent || null,
    metrics: result.metrics || null
  };
}

export {
  compactCommandOutput,
  extractRawPathFromContent
};
