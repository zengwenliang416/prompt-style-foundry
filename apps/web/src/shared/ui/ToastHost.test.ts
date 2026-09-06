// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dismissToast, pushToast, toastState } from './toast.js';
import ToastHost from './ToastHost.vue';

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const item of [...toastState.items]) {
      dismissToast(item.id);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders pushed toasts in a polite live region with dismiss buttons', async () => {
    const wrapper = mount(ToastHost);
    pushToast('已复制提示词', 'success');
    await wrapper.vm.$nextTick();

    expect(wrapper.attributes('aria-live')).toBe('polite');
    const toasts = wrapper.findAll('.toast');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.text()).toContain('已复制提示词');
    expect(toasts[0]?.attributes('role')).toBe('status');
  });

  it('announces error toasts assertively', async () => {
    const wrapper = mount(ToastHost);
    pushToast('网络失败', 'error');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.toast').attributes('role')).toBe('alert');
  });

  it('removes a toast on dismiss', async () => {
    const wrapper = mount(ToastHost);
    const id = pushToast('临时提示', 'info');
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.toast')).toHaveLength(1);

    await wrapper.find('.toast__dismiss').trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.toast')).toHaveLength(0);
    expect(toastState.items.find((item) => item.id === id)).toBeUndefined();
  });

  it('auto-dismisses after the timeout', () => {
    pushToast('临时提示', 'info', 3000);
    expect(toastState.items).toHaveLength(1);

    vi.advanceTimersByTime(2999);
    expect(toastState.items).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(toastState.items).toHaveLength(0);
  });
});
