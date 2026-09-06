<script setup lang="ts">
import { RouterView } from 'vue-router';

import AppShell from './shell/AppShell.vue';
import { ToastHost } from '../shared/ui/index.js';
</script>

<template>
  <AppShell>
    <RouterView />
  </AppShell>
  <ToastHost />
</template>
