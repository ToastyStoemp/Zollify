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
  },
};

// Dev-only live reload: CAP_SERVER_URL=http://<pc-lan-ip>:5180 npx cap sync android
if (process.env.CAP_SERVER_URL) {
  config.server = { ...config.server, url: process.env.CAP_SERVER_URL, cleartext: true };
}

export default config;
