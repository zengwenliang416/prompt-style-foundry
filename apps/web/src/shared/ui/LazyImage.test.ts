// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import LazyImage from './LazyImage.vue';

describe('LazyImage (U03 lazy previews)', () => {
  it('renders with native lazy loading and async decoding', () => {
    const wrapper = mount(LazyImage, {
      props: { src: '/previews/case-1.webp', alt: 'case-1 预览' },
    });
    const img = wrapper.find('img');
    expect(img.attributes('loading')).toBe('lazy');
    expect(img.attributes('decoding')).toBe('async');
    expect(img.attributes('alt')).toBe('case-1 预览');
  });

  it('reserves layout space via aspect ratio and fades in on load', async () => {
    const wrapper = mount(LazyImage, {
      props: { src: '/previews/case-1.webp', alt: '预览', aspectRatio: '3 / 2' },
    });
    expect(wrapper.find('.lazy-image').attributes('style')).toContain('aspect-ratio: 3 / 2');

    await wrapper.find('img').trigger('load');
    expect(wrapper.find('img').classes()).toContain('lazy-image__img--loaded');
    expect(wrapper.emitted('load')).toHaveLength(1);
  });

  it('shows a status fallback when the preview fails and emits error', async () => {
    const wrapper = mount(LazyImage, { props: { src: '/previews/missing.webp', alt: 'x' } });

    await wrapper.find('img').trigger('error');
    expect(wrapper.emitted('error')).toHaveLength(1);
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('.lazy-image__fallback').text()).toBe('预览不可用');
  });

  it('resets its state when the source changes', async () => {
    const wrapper = mount(LazyImage, { props: { src: '/previews/a.webp', alt: 'a' } });
    await wrapper.find('img').trigger('error');
    expect(wrapper.find('.lazy-image__fallback').exists()).toBe(true);

    await wrapper.setProps({ src: '/previews/b.webp' });
    expect(wrapper.find('.lazy-image__fallback').exists()).toBe(false);
    expect(wrapper.find('img').exists()).toBe(true);
  });
});
