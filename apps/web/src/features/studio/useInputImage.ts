import { getCurrentInstance, onBeforeUnmount, ref } from 'vue';

/**
 * Single-image input state for the workbench (U07, architecture §5/§8):
 * exactly one image, JPEG/PNG/WebP only, 20 MiB client-side ceiling (byte and
 * pixel limits are enforced server-side at precheck; this is early UX
 * feedback, not the security boundary). Object URLs are revoked on replace,
 * remove, and unmount so previews never leak.
 */

export const MAX_INPUT_BYTES = 20 * 1024 * 1024;

const ACCEPTED_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

export type ImageAcceptResult = 'accepted' | 'empty' | 'multiple' | 'type' | 'size';

export const REJECT_MESSAGES: Record<Exclude<ImageAcceptResult, 'accepted' | 'empty'>, string> = {
  multiple: '单图协议：一次只能提供一张参考图，请只选择一个文件。',
  type: '仅支持 JPEG / PNG / WebP 格式的图片。',
  size: '图片超过 20 MiB 上限，请压缩后重试。',
};

export interface InputImageState {
  file: import('vue').Ref<File | null>;
  objectUrl: import('vue').Ref<string | null>;
  error: import('vue').Ref<string | null>;
  accept: (files: FileList | File[]) => ImageAcceptResult;
  remove: () => void;
}

export function useInputImage(maxBytes: number = MAX_INPUT_BYTES): InputImageState {
  const file = ref<File | null>(null);
  const objectUrl = ref<string | null>(null);
  const error = ref<string | null>(null);

  function revoke(): void {
    if (objectUrl.value !== null) {
      URL.revokeObjectURL(objectUrl.value);
      objectUrl.value = null;
    }
  }

  function accept(list: FileList | File[]): ImageAcceptResult {
    const files = Array.from(list);
    if (files.length === 0) {
      return 'empty';
    }
    if (files.length > 1) {
      error.value = REJECT_MESSAGES.multiple;
      return 'multiple';
    }
    const candidate = files[0];
    if (candidate === undefined) {
      return 'empty';
    }
    if (!ACCEPTED_TYPES.includes(candidate.type)) {
      error.value = REJECT_MESSAGES.type;
      return 'type';
    }
    if (candidate.size > maxBytes) {
      error.value = REJECT_MESSAGES.size;
      return 'size';
    }

    revoke();
    file.value = candidate;
    objectUrl.value = URL.createObjectURL(candidate);
    error.value = null;
    return 'accepted';
  }

  function remove(): void {
    revoke();
    file.value = null;
    error.value = null;
  }

  if (getCurrentInstance() !== null) {
    onBeforeUnmount(revoke);
  }

  return { file, objectUrl, error, accept, remove };
}
