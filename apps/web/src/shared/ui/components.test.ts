// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import Chip from './Chip.vue';
import Tabs from './Tabs.vue';
import Dropzone from './Dropzone.vue';

describe('Chip', () => {
  it('exposes its toggle state via aria-pressed and emits toggle', async () => {
    const wrapper = mount(Chip, { props: { selected: false }, slots: { default: '文生图蓝图' } });
    expect(wrapper.attributes('aria-pressed')).toBe('false');

    await wrapper.trigger('click');
    expect(wrapper.emitted('toggle')).toHaveLength(1);
  });
});

describe('Tabs', () => {
  const tabs = [
    { id: 'template', label: '单图模板' },
    { id: 'example', label: '示例实际提示词' },
    { id: 'common', label: '公共规则' },
  ];

  it('marks the active tab with aria-selected and roving tabindex', () => {
    const wrapper = mount(Tabs, { props: { tabs, modelValue: 'example' } });
    const buttons = wrapper.findAll('[role="tab"]');
    expect(buttons[1]?.attributes('aria-selected')).toBe('true');
    expect(buttons[1]?.attributes('tabindex')).toBe('0');
    expect(buttons[0]?.attributes('tabindex')).toBe('-1');
  });

  it('emits update:modelValue on click', async () => {
    const wrapper = mount(Tabs, { props: { tabs, modelValue: 'template' } });
    await wrapper.findAll('[role="tab"]')[2]!.trigger('click');
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['common']);
  });

  it('moves selection with arrow keys', async () => {
    const wrapper = mount(Tabs, { props: { tabs, modelValue: 'template' } });
    await wrapper.find('[role="tablist"]').trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['example']);
  });
});

describe('Dropzone', () => {
  function makeFile(name: string): File {
    return new File(['onepic'], name, { type: 'image/png' });
  }

  it('emits selected files and exposes the picker button', async () => {
    const wrapper = mount(Dropzone, { props: { hint: '选择一张参考图' } });
    expect(wrapper.text()).toContain('选择一张参考图');

    const input = wrapper.find('input[type="file"]');
    // happy-dom cannot populate FileList programmatically; assert the
    // change wiring via the input element and the emitted event contract.
    Object.defineProperty(input.element, 'files', { value: [makeFile('a.png')] });
    await input.trigger('change');
    expect(wrapper.emitted('files')?.[0]).toEqual([[expect.objectContaining({ name: 'a.png' })]]);
  });

  it('keeps the file input reachable for keyboard users', () => {
    const wrapper = mount(Dropzone, {});
    expect(wrapper.find('input[type="file"]').exists()).toBe(true);
    expect(wrapper.find('button').text()).toBe('选择图片');
  });

  it('shows drag-over affordance and ignores drops while disabled', async () => {
    const wrapper = mount(Dropzone, { props: { disabled: true } });
    const dropEvent = { dataTransfer: { files: [makeFile('a.png')] } };
    await wrapper.trigger('dragover');
    expect(wrapper.classes()).toContain('dropzone--over');

    await wrapper.trigger('drop', dropEvent);
    expect(wrapper.emitted('files')).toBeUndefined();
  });
});
