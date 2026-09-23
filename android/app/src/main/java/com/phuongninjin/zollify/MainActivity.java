package com.phuongninjin.zollify;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Diagnostic aid while tracking down why content updates
        // (@capgo/capacitor-updater) aren't applying on a real device -
        // release builds otherwise leave this off, which is exactly why we
        // can't see what checkAndQueueShellUpdate()'s try/catch is
        // swallowing. Lets `chrome://inspect` (Chrome on a PC, phone over
        // USB with USB debugging on) attach to this WebView and read its
        // console/network directly. Not a real security exposure - it only
        // works over a physical USB connection - but this was left
        // unconditional on purpose for this debugging pass; consider
        // gating it behind BuildConfig.DEBUG again once the update path is
        // confirmed working.
        WebView.setWebContentsDebuggingEnabled(true);
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
