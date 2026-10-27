import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

// A file dropped anywhere but a row would make Electron navigate to it and leave the app.
for (const type of ['dragover', 'drop'] as const) document.addEventListener(type, (e) => e.preventDefault());

createApp(App).mount('#app');
