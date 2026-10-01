import { describe, expect, it } from 'vitest';
import { codexDeepLink, handoffPrompt } from '../src/integrations/chatgpt/launch';
describe('Codex handoff', () => {
  it('round trips paths, Unicode, and context references without submitting', () => {
    const context = { path: '/work/My project & research/日本', vaultName: 'research', itemIds: ['one', 'two'] };
    const url = new URL(codexDeepLink(context));
    expect(url.protocol).toBe('codex:'); expect(url.host).toBe('threads'); expect(url.pathname).toBe('/new');
    expect(url.searchParams.get('path')).toBe(context.path);
    expect(url.searchParams.get('prompt')).toBe(handoffPrompt(context));
    expect([...url.searchParams.keys()]).toEqual(['path', 'prompt']);
    expect(url.searchParams.get('prompt')).toContain('one, two');
  });
  it('accepts Windows paths and refuses relative paths', () => {
    expect(new URL(codexDeepLink({ path: 'C:\\work\\project', vaultName: 'x', itemIds: [] })).searchParams.get('path')).toBe('C:\\work\\project');
    expect(() => codexDeepLink({ path: 'relative/project', vaultName: 'x', itemIds: [] })).toThrow('absolute');
  });
});
