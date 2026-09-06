// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_INPUT_BYTES, REJECT_MESSAGES, useInputImage } from './useInputImage.js';

function makeFile(name: string, type: string, size: number): File {
  return new File([new Uint8Array(Math.max(1, size))], name, { type });
}

function withUrlStubs(): { created: string[]; revoked: string[] } {
  const created: string[] = [];
  const revoked: string[] = [];
  let counter = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => {
      const url = `blob:mock-${counter++}`;
      created.push(url);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => {
      revoked.push(url);
    }),
  });
  return { created, revoked };
}

describe('useInputImage (U07 single-image protocol)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts a single supported image and creates exactly one object URL', () => {
    const { created, revoked } = withUrlStubs();
    const image = useInputImage();

    const result = image.accept([makeFile('a.png', 'image/png', 1024)]);

    expect(result).toBe('accepted');
    expect(image.file.value?.name).toBe('a.png');
    expect(image.objectUrl.value).toBe(created[0]);
    expect(image.error.value).toBeNull();
    expect(revoked).toHaveLength(0);
  });

  it('rejects multiple files with the single-image message', () => {
    withUrlStubs();
    const image = useInputImage();

    const result = image.accept([
      makeFile('a.png', 'image/png', 10),
      makeFile('b.png', 'image/png', 10),
    ]);

    expect(result).toBe('multiple');
    expect(image.error.value).toBe(REJECT_MESSAGES.multiple);
    expect(image.file.value).toBeNull();
  });

  it('rejects unsupported formats', () => {
    withUrlStubs();
    const image = useInputImage();

    const result = image.accept([makeFile('x.gif', 'image/gif', 10)]);

    expect(result).toBe('type');
    expect(image.error.value).toBe(REJECT_MESSAGES.type);
    expect(image.file.value).toBeNull();
  });

  it('rejects oversized images above the 20 MiB ceiling', () => {
    withUrlStubs();
    const image = useInputImage();

    const result = image.accept([makeFile('big.png', 'image/png', MAX_INPUT_BYTES + 1)]);

    expect(result).toBe('size');
    expect(image.error.value).toBe(REJECT_MESSAGES.size);
  });

  it('revokes the previous URL when the image is replaced', () => {
    const { created, revoked } = withUrlStubs();
    const image = useInputImage();

    image.accept([makeFile('a.png', 'image/png', 10)]);
    image.accept([makeFile('b.jpeg', 'image/jpeg', 10)]);

    expect(image.file.value?.name).toBe('b.jpeg');
    expect(revoked).toEqual([created[0]]);
    expect(image.objectUrl.value).toBe(created[1]);
  });

  it('revokes the URL and clears state on remove', () => {
    const { created, revoked } = withUrlStubs();
    const image = useInputImage();

    image.accept([makeFile('a.webp', 'image/webp', 10)]);
    image.remove();

    expect(image.file.value).toBeNull();
    expect(image.objectUrl.value).toBeNull();
    expect(image.error.value).toBeNull();
    expect(revoked).toEqual([created[0]]);
  });

  it('revokes the URL when the hosting component unmounts', () => {
    const { created, revoked } = withUrlStubs();
    const Host = defineComponent({
      setup(_, { expose }) {
        const image = useInputImage();
        expose({ image });
        return () => null;
      },
    });
    const wrapper = mount(Host);
    const exposed = wrapper.vm as unknown as {
      image: { accept: (files: File[]) => string };
    };
    exposed.image.accept([makeFile('a.png', 'image/png', 10)]);

    wrapper.unmount();
    expect(revoked).toEqual([created[0]]);
  });
});
