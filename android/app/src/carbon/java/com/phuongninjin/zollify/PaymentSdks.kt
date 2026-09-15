package com.phuongninjin.zollify

import android.app.Application
import android.content.Intent
import com.getcapacitor.BridgeActivity

/**
 * Flavor hook - the "carbon" flavor runs ON a myPOS Carbon/Ultra terminal and
 * ships the myPOS Smart SDK for on-device payments. No SumUp here.
 */
object PaymentSdks {
    fun init(app: Application) {}

    fun registerPlugins(activity: BridgeActivity) {
        activity.registerPlugin(CarbonPaymentPlugin::class.java)
    }

    fun handleActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean =
        CarbonPaymentPlugin.handleActivityResult(requestCode, resultCode, data)
}
