/**
 * Normalize the shape returned from any provider's streamChat.
 *
 * Providers may return either:
 *   - a plain string (legacy / xml-only mode)
 *   - an object { content, thinking, nativeToolCalls, assistantMessage }
 *
 * This helper extracts the fields the agent loop and subagent loop both need.
 */
export function normalizeAssistantResponse(response) {
  if (typeof response === 'string') {
    return {
      text: response,
      thinking: '',
      nativeToolCalls: [],
      assistantMessage: { role: 'assistant', content: response },
    };
  }

  return {
    text: response?.content || '',
    thinking: response?.thinking || '',
    nativeToolCalls: response?.nativeToolCalls || [],
    assistantMessage: response?.assistantMessage || { role: 'assistant', content: response?.content || '' },
  };
}
