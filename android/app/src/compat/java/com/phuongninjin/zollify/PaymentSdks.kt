package com.phuongninjin.zollify

import android.app.Application
import android.content.Intent
import com.getcapacitor.BridgeActivity

/**
 * Flavor hook — the "compat" flavor (minSdk 24, Android 7 tablets) ships
 * without the SumUp SDK. No SumUp plugin is registered, so the web app's
 * SumUp provider reports itself as unavailable.
 */
object PaymentSdks {
    fun init(app: Application) {}

    fun registerPlugins(activity: BridgeActivity) {}

    fun handleActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean = false
}
