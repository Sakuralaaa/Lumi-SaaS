import { App } from 'antd';
import { useCallback } from 'react';
import { ApiError } from '../api/client';

/** Returns a function that shows any thrown error's (server-provided) message as plain text. */
export function useErrorToast() {
  const { message } = App.useApp();
  return useCallback((e: unknown) => {
    if (e instanceof ApiError && e.redirected) return; // already navigating to /login
    if (e instanceof ApiError && e.code === 'must_change_password') return; // the forced password modal is showing
    const text = e instanceof ApiError ? e.message : '出了点问题，请稍后再试';
    message.error(String(text));
  }, [message]);
}
