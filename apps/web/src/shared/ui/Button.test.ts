// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import Button from './Button.vue';

describe('Button', () => {
  it('renders its label and emits native clicks', async () => {
    const wrapper = mount(Button, { slots: { default: '生成图片' } });
    expect(wrapper.text()).toContain('生成图片');

    await wrapper.trigger('click');
    expect(wrapper.emitted('click')).toHaveLength(1);
  });

  it('blocks clicks while disabled', async () => {
    const wrapper = mount(Button, { props: { disabled: true }, slots: { default: '删除' } });
    expect(wrapper.attributes('disabled')).toBeDefined();

    await wrapper.trigger('click');
    expect(wrapper.emitted('click')).toBeUndefined();
  });

  it('exposes busy state and disables while loading', () => {
    const wrapper = mount(Button, { props: { loading: true }, slots: { default: '提交' } });
    expect(wrapper.attributes('aria-busy')).toBe('true');
    expect(wrapper.attributes('disabled')).toBeDefined();
    expect(wrapper.find('.btn__spinner').exists()).toBe(true);
  });

  it('keeps the native button keyboard path (Enter/Space)', async () => {
    const wrapper = mount(Button, { slots: { default: '复制' } });
    await wrapper.trigger('keydown.enter');
    await wrapper.trigger('keydown.space');
    // Native <button> dispatches click for Enter/Space at the DOM level; the
    // test asserts the element is a real button, not a div.
    expect(wrapper.element.tagName).toBe('BUTTON');
    expect(wrapper.attributes('type')).toBe('button');
  });
});
