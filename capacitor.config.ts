import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android shell around the web app. Three flavours are built from one
 * project (android/app/build.gradle): "carbon" runs on a myPOS Carbon
 * terminal, "compat" installs on Android 7 tablets without the SumUp SDK,
 * "full" carries SumUp and myPOS Glass. The web assets are identical; the
 * app asks for the server address on its first sign-in.
 */
const config: CapacitorConfig = {
  appId: 'com.phuongninjin.zollify',
  appName: 'Zollify',
  webDir: 'apps/web/dist',
  android: {
    buildOptions: { releaseType: 'APK' },
  },
  server: {
    androidScheme: 'http',
  },
  plugins: {
    // The app UI is always dark - light system-bar icons regardless of device theme.
    SystemBars: { style: 'DARK' },
    // Manual mode: this app drives its own check/download/apply against its
    // own server (see packages/platform/src/shell-updates.ts) rather than
    // Capgo's hosted channel API - autoUpdate: true would try to talk to
    // Capgo Cloud, which this deploy doesn't use.
    CapacitorUpdater: { autoUpdate: false },
  },
};

// Dev-only live reload: CAP_SERVER_URL=http://<pc-lan-ip>:5180 npx cap sync android
if (process.env.CAP_SERVER_URL) {
  config.server = { ...config.server, url: process.env.CAP_SERVER_URL, cleartext: true };
}

export default config;
