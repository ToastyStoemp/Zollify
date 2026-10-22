<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { GO2_DEFAULT_PORT, GO2_HOST_SETTING, GO2_PORT_SETTING, GO2_TRANSPORT_SETTING, connectGo2, type Go2Transport } from '../payments/mypos-go2';
import { getSetting, setSetting } from '../lib/settings';
import { sdk } from '../runtime';

/**
 * How this device reaches the Go2 - Bluetooth, or Wi-Fi with the terminal's
 * address. Shown right where the Go2 is being connected (the terminal list
 * under Settings, the first-run setup), not apart from it. Saving reconnects
 * when `connect` is set, i.e. when the Go2 is the terminal in use.
 */
const props = defineProps<{ connect?: boolean }>();
const emit = defineEmits<{ saved: [transport: Go2Transport]; loaded: [transport: Go2Transport] }>();

const go2 = ref({ transport: 'bluetooth' as Go2Transport, host: '', port: String(GO2_DEFAULT_PORT) });

onMounted(async () => {
  go2.value = {
    transport: ((await getSetting<string>(GO2_TRANSPORT_SETTING)) === 'wifi' ? 'wifi' : 'bluetooth') as Go2Transport,
    host: (await getSetting<string>(GO2_HOST_SETTING)) ?? '',
    port: String((await getSetting<number | string>(GO2_PORT_SETTING)) ?? GO2_DEFAULT_PORT),
  };
  emit('loaded', go2.value.transport);
});

async function save(): Promise<void> {
  await setSetting(GO2_TRANSPORT_SETTING, go2.value.transport);
  await setSetting(GO2_HOST_SETTING, go2.value.host.trim());
  await setSetting(GO2_PORT_SETTING, Number(go2.value.port) || GO2_DEFAULT_PORT);
  // Wi-Fi with no address yet has nothing to connect to.
  if (props.connect && (go2.value.transport === 'bluetooth' || go2.value.host.trim())) {
    try {
      await connectGo2();
    } catch (err) {
      sdk().ui.toast(err instanceof Error ? err.message : String(err), { kind: 'error' });
    }
  }
  emit('saved', go2.value.transport);
}
</script>

<template>
  <fieldset class="go2">
    <legend>How this device reaches the Go2</legend>
    <div class="ways">
      <label :class="{ on: go2.transport === 'wifi' }"><input v-model="go2.transport" type="radio" value="wifi" @change="save" /> <span>Wi-Fi <small>same network</small></span></label>
      <label :class="{ on: go2.transport === 'bluetooth' }"><input v-model="go2.transport" type="radio" value="bluetooth" @change="save" /> <span>Bluetooth</span></label>
    </div>
    <template v-if="go2.transport === 'wifi'">
      <div class="row">
        <label class="field grow"><span>Terminal IP address</span><input v-model="go2.host" type="text" inputmode="decimal" autocomplete="off" placeholder="192.168.1.100" @change="save" /></label>
        <label class="field port"><span>Port</span><input v-model="go2.port" type="number" inputmode="numeric" min="1" max="65535" @change="save" /></label>
      </div>
      <p class="hint">Put the Go2 in slave mode on the same Wi-Fi as this device. Its IP address is under the terminal’s connection settings; the port is {{ GO2_DEFAULT_PORT }} unless you changed it there. Then tap <strong>Connect</strong>.</p>
    </template>
    <p v-else class="hint">Bluetooth only works on a Go2 ordered with the Bluetooth module - a plain Go2 has none, however long it scans. If pairing never finds the terminal, use Wi-Fi.</p>
  </fieldset>
</template>

<style scoped>
.go2 { display: flex; flex-direction: column; gap: .5rem; margin: 0; padding: .6rem .7rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; min-width: 0; }
legend { padding: 0 .3rem; font-size: .85rem; font-weight: 600; }
.ways { display: flex; flex-wrap: wrap; gap: .4rem; }
.ways label { display: flex; align-items: center; gap: .4rem; padding: .35rem .6rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; font-size: .875rem; cursor: pointer; }
.ways label.on { border-color: var(--zfy-accent, #0e7c66); background: var(--zfy-accent-soft, #e6f3f0); }
.ways small { color: var(--zfy-muted, #5a6472); font-size: .74rem; }
.row { display: flex; align-items: flex-end; gap: .5rem; }
.field { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.grow { flex: 1; min-width: 0; }
.port { max-width: 7rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .82rem; }
</style>
