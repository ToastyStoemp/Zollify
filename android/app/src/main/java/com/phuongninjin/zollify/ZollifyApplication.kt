package com.phuongninjin.zollify

import android.app.Application

class ZollifyApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        PaymentSdks.init(this)
    }
}
