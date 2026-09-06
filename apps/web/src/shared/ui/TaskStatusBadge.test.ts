// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import TaskStatusBadge from './TaskStatusBadge.vue';

describe('TaskStatusBadge (U09)', () => {
  it.each([
    ['created', '已创建'],
    ['queued', '排队中'],
    ['running', '生成中'],
    ['succeeded', '已完成'],
    ['failed', '失败'],
    ['cancelled', '已取消'],
    ['expired', '结果过期'],
    ['outcome_unknown', '结果未知'],
  ])('renders %s with an accessible label', (status, label) => {
    const wrapper = mount(TaskStatusBadge, { props: { status } });
    expect(wrapper.attributes('role')).toBe('status');
    expect(wrapper.find('.task-status__label').text()).toBe(label);
  });

  it('never offers automatic retry for outcome_unknown', () => {
    const wrapper = mount(TaskStatusBadge, { props: { status: 'outcome_unknown' } });
    expect(wrapper.text()).toContain('结果未知，不会自动重试');
    expect(wrapper.text().replace(/不会自动重试/g, '')).not.toContain('重试');
  });

  it('states media expiry without rewriting the historical success', () => {
    const wrapper = mount(TaskStatusBadge, { props: { status: 'expired' } });
    expect(wrapper.text()).toContain('历史成功记录保留');
  });

  it('states a cancel request honestly while running', () => {
    const wrapper = mount(TaskStatusBadge, { props: { status: 'running', cancelRequested: true } });
    expect(wrapper.text()).toContain('已请求取消，不保证免计费');
    // It must not claim the task is already cancelled.
    expect(wrapper.find('.task-status__label').text()).toBe('生成中');
  });

  it('falls back to an explicit unknown label for invalid statuses', () => {
    const wrapper = mount(TaskStatusBadge, {
      props: { status: 'definitely-not-a-state' as string },
    });
    expect(wrapper.find('.task-status__label').text()).toBe('未知状态');
    // An invalid state must not inherit a real state's tone.
    expect(wrapper.classes()).toContain('task-status--info');
  });
});
