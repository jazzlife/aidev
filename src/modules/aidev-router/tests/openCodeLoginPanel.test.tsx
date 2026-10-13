import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import { aidevApi } from '@/modules/aidev-router/api';
import { OpenCodeLoginPanel } from '@/modules/aidev-router/OpenCodeLoginPanel';

/**
 * The OpenCode login panel: a provider and its API key go to the runtime; OpenCode Go is the first choice (the terminal
 * login hides it behind a search), and the key never stays in the field.
 */
beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(aidevApi, 'engines').mockResolvedValue({} as never); });

test('stores the key under the picked provider and says what is connected', async () => {
  vi.spyOn(aidevApi, 'openCodeLoginProviders').mockResolvedValue({ providers: ['openai'] });
  const store = vi.spyOn(aidevApi, 'openCodeLoginKey').mockResolvedValue({ provider: 'opencode-go', providers: ['openai', 'opencode-go'] });
  const done = vi.fn();
  render(<OpenCodeLoginPanel onDone={done} />);
  await waitFor(() => screen.getByText(/지금 연결된 공급자: OpenAI API\./));
  assert.equal((screen.getByLabelText('OpenCode 공급자') as HTMLSelectElement).value, 'opencode-go', 'OpenCode Go first');
  assert.equal(screen.getByRole('link', { name: /키 만드는 페이지 열기/ }).getAttribute('href'), 'https://opencode.ai/auth');
  const keyField = screen.getByLabelText('OpenCode API 키') as HTMLInputElement;
  assert.equal(keyField.type, 'password');
  fireEvent.change(keyField, { target: { value: '  sk-go-0123456789  ' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /저장/ })); });
  assert.deepEqual(store.mock.calls[0], ['opencode-go', 'sk-go-0123456789']);
  await waitFor(() => screen.getByText(/OpenCode Go \(구독\) 키를 저장했습니다/));
  assert.equal(keyField.value, '', 'the key does not stay on the page');
  assert.equal(done.mock.calls.length, 1);
  assert.ok(screen.getByText(/지금 연결된 공급자: OpenAI API, OpenCode Go \(구독\)\./));
});

test('another provider by id, a refusal shown as it came, and the way to the terminal login', async () => {
  vi.spyOn(aidevApi, 'openCodeLoginProviders').mockResolvedValue({ providers: [] });
  const store = vi.spyOn(aidevApi, 'openCodeLoginKey').mockRejectedValue(new Error('API 키 형식이 올바르지 않습니다.'));
  const terminal = vi.fn();
  render(<OpenCodeLoginPanel onUseTerminal={terminal} />);
  fireEvent.change(screen.getByLabelText('OpenCode 공급자'), { target: { value: '__other__' } });
  fireEvent.change(screen.getByLabelText('OpenCode 공급자 id'), { target: { value: ' Groq ' } });
  fireEvent.change(screen.getByLabelText('OpenCode API 키'), { target: { value: 'gsk_x' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /저장/ })); });
  assert.deepEqual(store.mock.calls[0], ['groq', 'gsk_x']);
  await waitFor(() => screen.getByText('API 키 형식이 올바르지 않습니다.'));
  fireEvent.click(screen.getByRole('button', { name: /터미널로 로그인/ }));
  assert.equal(terminal.mock.calls.length, 1);
});
