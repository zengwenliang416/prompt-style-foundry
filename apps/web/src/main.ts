import { createApp } from 'vue';
import { createPinia } from 'pinia';

import App from './app/App.vue';
import { createAppRouter } from './app/router.js';
import './app/styles/base.css';
import './app/styles/tokens.css';

const app = createApp(App);
app.use(createPinia());
app.use(createAppRouter());
app.mount('#app');
