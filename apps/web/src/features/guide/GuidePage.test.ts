// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import GuidePage from './GuidePage.vue';

describe('GuidePage (U11)', () => {
  const wrapper = mount(GuidePage);

  it('presents the core protocol headline and flow', () => {
    expect(wrapper.find('h1').text()).toContain('图片决定内容，蓝图决定风格');
    expect(wrapper.text()).toContain('上传一张图片');
    expect(wrapper.text()).toContain('生成结果');
  });

  it('explains the priority order: image > blueprint > sample content', () => {
    expect(wrapper.text()).toContain('你上传的图片决定内容');
    expect(wrapper.text()).toContain('模板蓝图决定视觉处理');
    expect(wrapper.text()).toContain('示例内容不覆盖你的图');
  });

  it('documents both blueprint types and the real run modes', () => {
    expect(wrapper.text()).toContain('文生图蓝图');
    expect(wrapper.text()).toContain('图生图蓝图');
    expect(wrapper.text()).toContain('目录浏览');
    expect(wrapper.text()).toContain('BYOK 直连');
    expect(wrapper.text()).toContain('受管生成');
    expect(wrapper.text()).toContain('未开放');
    expect(wrapper.text()).toContain('配置接口与隐私');
  });

  it('covers source provenance and prompt structure', () => {
    expect(wrapper.text()).toContain('SHA-256');
    expect(wrapper.text()).toContain('[System / Prompt]');
    expect(wrapper.text()).toContain('BEGIN VISUAL BLUEPRINT');
    expect(wrapper.text()).toContain('MIT');
  });

  it('mentions Nano Banana Pro as preferred-when-available, not exclusive', () => {
    expect(wrapper.text()).toContain('Nano Banana Pro');
    expect(wrapper.text()).toContain('不是唯一选项');
  });

  it('never contains the forbidden direct-i2i ban or fake zero-relay claims', () => {
    const text = wrapper.text();
    expect(text).not.toContain('禁止直接图生图');
    expect(text).not.toContain('禁止图生图');
    expect(text).not.toContain('零中转');
    expect(text).not.toContain('完全不上传');
    // Footer keeps the honest direct-connection statement.
    expect(wrapper.find('.guide__footer').text()).toContain('数据只在你点击生成后直连自定义接口');
  });
});
