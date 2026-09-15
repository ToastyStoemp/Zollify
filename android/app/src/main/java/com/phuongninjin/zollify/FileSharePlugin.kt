package com.phuongninjin.zollify

import android.app.Activity
import android.content.Intent
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

@CapacitorPlugin(name = "FileShare")
class FileSharePlugin : Plugin() {

    private var pendingBytes: ByteArray? = null

    // content is UTF-8 text by default; pass encoding = "base64" for binary files (PDF, images)
    private fun decodeContent(call: PluginCall): ByteArray? {
        val content = call.getString("content") ?: return null
        return if (call.getString("encoding") == "base64") {
            Base64.decode(content, Base64.DEFAULT)
        } else {
            content.toByteArray()
        }
    }

    @PluginMethod
    fun shareFile(call: PluginCall) {
        val filename = call.getString("filename") ?: run { call.reject("filename required"); return }
        val bytes    = decodeContent(call)        ?: run { call.reject("content required");  return }
        val mimeType = call.getString("mimeType") ?: "application/json"

        try {
            val file = File(activity.cacheDir, filename)
            file.writeBytes(bytes)
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, filename)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(Intent.createChooser(intent, filename))
            call.resolve(JSObject().apply { put("shared", true) })
        } catch (e: Exception) {
            call.reject("Share failed: ${e.message}")
        }
    }

    // Open a document in the device's own viewer (browser for HTML, PDF app for
    // PDF, …) via an ACTION_VIEW intent, instead of the share sheet. Falls back
    // to sharing if no installed app can view the given mime type.
    @PluginMethod
    fun openFile(call: PluginCall) {
        val filename = call.getString("filename") ?: run { call.reject("filename required"); return }
        val bytes    = decodeContent(call)        ?: run { call.reject("content required");  return }
        val mimeType = call.getString("mimeType") ?: "*/*"

        try {
            val file = File(activity.cacheDir, filename)
            file.writeBytes(bytes)
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
            val view = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mimeType)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            try {
                activity.startActivity(view)
                call.resolve(JSObject().apply { put("opened", true) })
            } catch (e: android.content.ActivityNotFoundException) {
                // Nothing can view this type — fall back to the share sheet.
                val share = Intent(Intent.ACTION_SEND).apply {
                    type = mimeType
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_SUBJECT, filename)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                activity.startActivity(Intent.createChooser(share, filename))
                call.resolve(JSObject().apply { put("opened", false); put("shared", true) })
            }
        } catch (e: Exception) {
            call.reject("Open failed: ${e.message}")
        }
    }

    @PluginMethod
    fun saveToDevice(call: PluginCall) {
        val filename = call.getString("filename") ?: run { call.reject("filename required"); return }
        val bytes    = decodeContent(call)        ?: run { call.reject("content required");  return }
        val mimeType = call.getString("mimeType") ?: "application/json"

        pendingBytes = bytes

        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType
            putExtra(Intent.EXTRA_TITLE, filename)
        }
        startActivityForResult(call, intent, "saveDocumentResult")
    }

    // ── Streamed save (large files, e.g. ZIP backups) ─────────────────────────
    // saveToDevice ships the whole payload across the JS bridge in one message,
    // which OOMs old WebViews on multi-MB backups. This variant opens the SAF
    // document once and appends base64 chunks, so peak memory stays at one chunk.

    private var streamOut: java.io.OutputStream? = null

    @PluginMethod
    fun beginSave(call: PluginCall) {
        val filename = call.getString("filename") ?: run { call.reject("filename required"); return }
        val mimeType = call.getString("mimeType") ?: "application/octet-stream"
        if (streamOut != null) { try { streamOut?.close() } catch (_: Exception) {}; streamOut = null }

        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType
            putExtra(Intent.EXTRA_TITLE, filename)
        }
        startActivityForResult(call, intent, "beginSaveResult")
    }

    @ActivityCallback
    private fun beginSaveResult(call: PluginCall?, result: ActivityResult) {
        val c = call ?: return
        if (result.resultCode != Activity.RESULT_OK) {
            c.resolve(JSObject().apply { put("opened", false); put("cancelled", true) })
            return
        }
        val uri = result.data?.data ?: run { c.reject("No URI returned"); return }
        try {
            streamOut = activity.contentResolver.openOutputStream(uri)
            c.resolve(JSObject().apply { put("opened", true) })
        } catch (e: Exception) {
            c.reject("Open failed: ${e.message}")
        }
    }

    @PluginMethod
    fun writeChunk(call: PluginCall) {
        val out  = streamOut ?: run { call.reject("No save in progress"); return }
        val data = call.getString("data") ?: run { call.reject("data required"); return }
        try {
            out.write(Base64.decode(data, Base64.DEFAULT))
            call.resolve()
        } catch (e: Exception) {
            try { out.close() } catch (_: Exception) {}
            streamOut = null
            call.reject("Write failed: ${e.message}")
        }
    }

    @PluginMethod
    fun endSave(call: PluginCall) {
        val out = streamOut
        streamOut = null
        if (out == null) { call.reject("No save in progress"); return }
        try {
            out.flush(); out.close()
            call.resolve(JSObject().apply { put("saved", true) })
        } catch (e: Exception) {
            call.reject("Close failed: ${e.message}")
        }
    }

    @PluginMethod
    fun abortSave(call: PluginCall) {
        try { streamOut?.close() } catch (_: Exception) {}
        streamOut = null
        call.resolve()
    }

    @ActivityCallback
    private fun saveDocumentResult(call: PluginCall?, result: ActivityResult) {
        val c = call ?: return
        val bytes = pendingBytes
        pendingBytes = null

        if (result.resultCode == Activity.RESULT_OK) {
            val uri = result.data?.data ?: run { c.reject("No URI returned"); return }
            try {
                activity.contentResolver.openOutputStream(uri)?.use {
                    it.write(bytes ?: byteArrayOf())
                }
                c.resolve(JSObject().apply { put("saved", true) })
            } catch (e: Exception) {
                c.reject("Write failed: ${e.message}")
            }
        } else {
            c.resolve(JSObject().apply { put("saved", false); put("cancelled", true) })
        }
    }
}
