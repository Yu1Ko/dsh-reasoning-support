export const TOOL_SEARCH = {
  name: 'tool_search',
  description: 'Find additional available tools by name or capability. Matching tools become directly callable through their native schemas in the next step. Search here before concluding that a needed capability is unavailable.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: { query: { type: 'string', description: 'Tool name, domain or needed capability.' } },
    required: ['query'],
  },
};

export const SKILL_SEARCH = {
  name: 'skill_search',
  description: 'Find relevant installed skills by name or description. Load a returned skill by its exact name with the native skill tool. No skill bodies are automatically injected by this search.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: { query: { type: 'string', description: 'Skill name or task domain.' } },
    required: ['query'],
  },
};
