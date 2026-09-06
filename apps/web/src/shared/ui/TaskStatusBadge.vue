<script setup lang="ts">
import { computed } from 'vue';

import type { GenerationStatus } from '@onepic/contracts';

/**
 * Generation task status badge (U09). Labels follow DESIGN.md §5 and the
 * architecture §9 state machine. `outcome_unknown` NEVER offers an automatic
 * retry — the honest text is "结果未知，不会自动重试" (no one-click retry is
 * rendered anywhere for it). `expired` keeps the historical success fact
 * visible while stating that the media itself is gone. A cancel request
 * while queued/running is expressed as "已请求取消，不保证免计费" — never as
 * a fake "cancelled". Unknown/invalid statuses render an explicit fallback
 * instead of something that could be mistaken for a real state.
 */

const props = withDefaults(
  defineProps<{
    status: GenerationStatus | string;
    cancelRequested?: boolean;
  }>(),
  { cancelRequested: false },
);

const STATUS_LABELS: Record<string, string> = {
  created: '已创建',
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  expired: '结果过期',
  outcome_unknown: '结果未知',
};

const STATUS_TONES: Record<string, 'info' | 'progress' | 'success' | 'danger' | 'warning'> = {
  created: 'info',
  queued: 'info',
  running: 'progress',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'info',
  expired: 'warning',
  outcome_unknown: 'warning',
};

const known = computed(() => props.status in STATUS_LABELS);
const label = computed(() => STATUS_LABELS[props.status] ?? '未知状态');
const tone = computed(() => STATUS_TONES[props.status] ?? 'info');

const cancelPending = computed(
  () => props.cancelRequested && (props.status === 'running' || props.status === 'queued'),
);
</script>

<template>
  <span class="task-status" :class="`task-status--${tone}`" role="status">
    <span class="task-status__label">{{ known ? label : '未知状态' }}</span>
    <template v-if="status === 'outcome_unknown'">
      <span class="task-status__detail">结果未知，不会自动重试；请通过查询或人工处置确认。</span>
    </template>
    <template v-else-if="status === 'expired'">
      <span class="task-status__detail">结果媒体已过期；历史成功记录保留。</span>
    </template>
    <template v-else-if="status === 'cancelled'">
      <span class="task-status__detail">任务已取消；取消不保证免计费。</span>
    </template>
    <span v-if="cancelPending" class="task-status__detail">已请求取消，不保证免计费。</span>
  </span>
</template>

<style scoped>
.task-status {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  flex-wrap: wrap;
  border-radius: var(--radius-control);
  padding: 0 var(--space-2);
  font-size: 0.8125rem;
}

.task-status__label {
  font-weight: 600;
}

.task-status--info {
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  color: var(--color-ink);
}

.task-status--progress {
  background: var(--color-accent-teal);
  color: var(--color-on-teal);
}

.task-status--success {
  background: var(--color-surface);
  border: 1px solid var(--color-accent-teal);
  color: var(--color-accent-teal);
}

.task-status--danger {
  background: var(--color-danger);
  color: var(--color-on-danger);
}

.task-status--warning {
  background: var(--color-accent-amber);
  color: var(--color-on-amber);
}

.task-status__detail {
  color: inherit;
  opacity: 0.85;
}
</style>
