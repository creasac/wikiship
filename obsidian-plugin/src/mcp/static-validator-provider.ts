// Substitute the MCP SDK's Ajv provider at build time. This supported provider
// validates schemas without runtime code generation.
export { CfWorkerJsonSchemaValidator as AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
