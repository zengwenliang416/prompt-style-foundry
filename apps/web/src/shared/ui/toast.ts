import { reactive } from 'vue';

export interface ToastItem {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
}

const state = reactive<{ items: ToastItem[] }>({ items: [] });

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function pushToast(
  message: string,
  tone: ToastItem['tone'] = 'info',
  timeoutMs = 5000,
): number {
  const id = nextId++;
  state.items.push({ id, message, tone });
  timers.set(
    id,
    setTimeout(() => dismissToast(id), timeoutMs),
  );
  return id;
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const index = state.items.findIndex((item) => item.id === id);
  if (index >= 0) {
    state.items.splice(index, 1);
  }
}

export const toastState = state;
