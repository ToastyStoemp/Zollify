package com.phuongninjin.zollify;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Was left unconditionally on for a debugging pass tracking down why
        // content updates (@capgo/capacitor-updater) weren't applying on a
        // real device (root cause found: the native plugin was never wired
        // into android/capacitor.settings.gradle - fixed separately). Gated
        // back to debug builds only - the carbon flavor goes through myPOS's
        // app validation, which a debuggable release WebView would fail.
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        registerPlugin(MyPosPlugin.class);
        registerPlugin(FileSharePlugin.class);
        registerPlugin(ThermalPrinterPlugin.class);
        registerPlugin(UpdaterPlugin.class);
        // Flavor-specific payment plugins (SumUp + Glass on "full", CarbonPayment on "carbon")
        PaymentSdks.INSTANCE.registerPlugins(this);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        // Flavor-provided payment SDKs may launch their own activities against this one.
        if (PaymentSdks.INSTANCE.handleActivityResult(requestCode, resultCode, data)) return;
        super.onActivityResult(requestCode, resultCode, data);
    }
}
