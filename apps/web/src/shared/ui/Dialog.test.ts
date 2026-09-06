// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import Dialog from './Dialog.vue';

describe('Dialog', () => {
  it('opens as a modal native dialog with an accessible title', async () => {
    const wrapper = mount(Dialog, { props: { title: '确认生成' } });
    const exposed = wrapper.vm as unknown as { open(): void; close(): void };
    exposed.open();
    await wrapper.vm.$nextTick();

    const dialog = wrapper.find('dialog');
    expect(dialog.attributes('open')).toBeDefined();
    expect(dialog.element.getAttribute('aria-labelledby')).toBe(dialog.find('h2').attributes('id'));
    expect(dialog.find('h2').text()).toBe('确认生成');
  });

  it('emits close when dismissed via the close button (Esc path shares @close)', async () => {
    const wrapper = mount(Dialog, { props: { title: '确认生成' } });
    const exposed = wrapper.vm as unknown as { open(): void; close(): void };
    exposed.open();
    await wrapper.vm.$nextTick();

    await wrapper.find('.dialog__close').trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(wrapper.find('dialog').attributes('open')).toBeUndefined();
  });

  it('routes the native Esc close event to the close emit', async () => {
    const wrapper = mount(Dialog, { props: { title: '确认生成' } });
    const exposed = wrapper.vm as unknown as { open(): void; close(): void };
    exposed.open();
    await wrapper.vm.$nextTick();

    // Esc on a native dialog fires the `close` event; simulate what the
    // browser does by dispatching that event from the dialog element.
    await wrapper.find('dialog').trigger('close');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
