package com.phuongninjin.zollify

import android.app.Application
import android.content.Intent
import com.getcapacitor.BridgeActivity
import com.sumup.reader.sdk.api.SumUpState

/** Flavor hook - the "full" flavor ships SumUp (minSdk 26) and myPOS Glass softPOS. */
object PaymentSdks {
    fun init(app: Application) {
        // A SumUp init failure must not take down app startup.
        try { SumUpState.init(app) } catch (_: Throwable) {}
    }

    fun registerPlugins(activity: BridgeActivity) {
        activity.registerPlugin(SumUpPlugin::class.java)
        activity.registerPlugin(GlassPaymentPlugin::class.java)
    }

    fun handleActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean =
        SumUpPlugin.handleActivityResult(requestCode, data) ||
            GlassPaymentPlugin.handleActivityResult(requestCode, resultCode, data)
}
