// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import Input from './Input.vue';

describe('Input', () => {
  it('associates the label with the field via for/id', () => {
    const wrapper = mount(Input, { props: { modelValue: '', label: '搜索模板' } });
    const label = wrapper.find('label');
    const field = wrapper.find('input');
    expect(label.attributes('for')).toBe(field.attributes('id'));
  });

  it('emits update:modelValue on input', async () => {
    const wrapper = mount(Input, { props: { modelValue: '', label: '搜索模板' } });
    await wrapper.find('input').setValue('海报');
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['海报']);
  });

  it('marks errors accessibly', () => {
    const wrapper = mount(Input, {
      props: { modelValue: 'x', label: '尺寸', error: '仅支持 1–8 字符' },
    });
    const field = wrapper.find('input');
    expect(field.attributes('aria-invalid')).toBe('true');
    const describedBy = field.attributes('aria-describedby');
    expect(describedBy).toBeDefined();
    const error = wrapper.find(`#${describedBy}`);
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain('仅支持 1–8 字符');
  });

  it('disables the field', () => {
    const wrapper = mount(Input, { props: { modelValue: '', label: '尺寸', disabled: true } });
    expect(wrapper.find('input').attributes('disabled')).toBeDefined();
  });
});
