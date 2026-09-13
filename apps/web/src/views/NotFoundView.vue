<template>
  <section class="nf">
    <h1>Not found</h1>
    <p>That screen doesn't exist, or belongs to a module that isn't switched on.</p>
    <router-link :to="{ name: 'home' }">Back to home</router-link>
  </section>
</template>

<style scoped>
.nf { display: flex; flex-direction: column; gap: .75rem; }
h1 { margin: 0; font-size: 1.35rem; }
p { margin: 0; color: var(--zfy-muted, #5a6472); }
</style>
