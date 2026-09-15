package com.phuongninjin.zollify

import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Self-update: reads this install's own version, downloads a newer APK
 * served by the Zollify server (packages/server-core/src/routes/updates.ts) to the app
 * cache with progress events, and separately launches the Android package
 * installer once asked to. Split into download()/install() rather than one
 * call so the download can run in the background (e.g. right after an
 * update-available check) while install stays a deliberate, user-triggered
 * step - Android requires the "install unknown app" consent dialog either
 * way, so this can never be fully silent.
 */
@CapacitorPlugin(name = "Updater")
class UpdaterPlugin : Plugin() {
    private val downloading = AtomicBoolean(false)

    private val apkFile: File
        get() = File(activity.cacheDir, "update.apk")

    @PluginMethod
    fun getCurrentVersion(call: PluginCall) {
        val pInfo = activity.packageManager.getPackageInfo(activity.packageName, 0)
        val result = JSObject()
        result.put("versionCode", PackageInfoCompat.getLongVersionCode(pInfo))
        result.put("versionName", pInfo.versionName)
        // Which build this is decides which APK to fetch - and that the carbon
        // build is updated through the terminal's own channel, never from here.
        result.put("flavor", BuildConfig.FLAVOR)
        call.resolve(result)
    }

    @PluginMethod
    fun download(call: PluginCall) {
        val urlString = call.getString("url") ?: run { call.reject("url required"); return }
        if (!downloading.compareAndSet(false, true)) {
            call.reject("A download is already in progress")
            return
        }
        Thread {
            // Written to a .part file first so a failed/interrupted download never
            // leaves a half-written file behind that install() could pick up.
            val partFile = File(activity.cacheDir, "update.apk.part")
            try {
                val connection = URL(urlString).openConnection() as HttpURLConnection
                // Without explicit timeouts a stalled connection (bad wifi, server
                // hiccup) hangs the download indefinitely with no feedback - this
                // was the "sometimes it just sits there for minutes" report.
                // readTimeout resets on every byte received, so it only fires on a
                // true stall, not a merely slow-but-flowing transfer.
                connection.connectTimeout = 15_000
                connection.readTimeout = 20_000
                connection.connect()
                if (connection.responseCode !in 200..299) {
                    throw IOException("Server returned HTTP ${connection.responseCode}")
                }
                val totalBytes = connection.contentLength
                var bytesWritten = 0L
                var lastEmit = 0L
                connection.inputStream.use { input ->
                    FileOutputStream(partFile).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read == -1) break
                            output.write(buffer, 0, read)
                            bytesWritten += read
                            if (bytesWritten - lastEmit >= 65_536) {
                                lastEmit = bytesWritten
                                emitProgress(bytesWritten, totalBytes.toLong())
                            }
                        }
                    }
                }
                if (apkFile.exists()) apkFile.delete()
                partFile.renameTo(apkFile)
                emitProgress(bytesWritten, if (totalBytes > 0) totalBytes.toLong() else bytesWritten)
                call.resolve()
            } catch (e: Exception) {
                partFile.delete()
                call.reject(e.message ?: "Download failed")
            } finally {
                downloading.set(false)
            }
        }.start()
    }

    private fun emitProgress(bytesWritten: Long, totalBytes: Long) {
        val progress = JSObject()
        progress.put("bytesWritten", bytesWritten)
        progress.put("totalBytes", totalBytes)
        notifyListeners("updateDownloadProgress", progress)
    }

    @PluginMethod
    fun install(call: PluginCall) {
        val file = apkFile
        if (!file.exists()) {
            call.reject("No downloaded update found")
            return
        }
        val uri: Uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
        call.resolve()
    }
}
