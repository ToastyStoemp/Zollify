package com.phuongninjin.zollify

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.util.Base64
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.ByteArrayOutputStream
import java.nio.charset.Charset
import java.util.UUID

/**
 * Generic Bluetooth ESC/POS thermal printer support (58mm / 384-dot class),
 * available in every flavor. The user pairs the printer in Android's Bluetooth
 * settings; we only list bonded devices and open an RFCOMM (SPP) socket — no
 * discovery, so no location permission and none of the scan crash surface.
 *
 * Takes the same pre-formatted 32-char receipt lines as CarbonPaymentPlugin
 * (see app/src/lib/receipt.ts) and renders them as ESC/POS bytes.
 */
@CapacitorPlugin(
    name = "ThermalPrinter",
    permissions = [
        // Android 12+: talking to bonded devices needs a runtime grant.
        Permission(alias = "bluetooth", strings = [Manifest.permission.BLUETOOTH_CONNECT]),
    ],
)
class ThermalPrinterPlugin : Plugin() {

    companion object {
        /** Standard Bluetooth Serial Port Profile UUID. */
        private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        private const val MAX_DOTS = 384
    }

    private fun missingConnectPermission(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            ContextCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_CONNECT) !=
            PackageManager.PERMISSION_GRANTED

    // ── Printer selection ─────────────────────────────────────────────────────

    @PluginMethod
    fun listPrinters(call: PluginCall) {
        if (missingConnectPermission()) {
            requestPermissionForAlias("bluetooth", call, "listPermissionCallback")
            return
        }
        resolvePrinterList(call)
    }

    @PermissionCallback
    private fun listPermissionCallback(call: PluginCall) {
        if (missingConnectPermission()) call.reject("Bluetooth permission denied")
        else resolvePrinterList(call)
    }

    @SuppressLint("MissingPermission")
    private fun resolvePrinterList(call: PluginCall) {
        val adapter = (activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        if (adapter == null || !adapter.isEnabled) { call.reject("Bluetooth is off"); return }
        val printers = JSArray()
        for (device in adapter.bondedDevices) {
            printers.put(JSObject().apply {
                put("name", device.name ?: device.address)
                put("address", device.address)
            })
        }
        call.resolve(JSObject().apply { put("printers", printers) })
    }

    // ── Printing ──────────────────────────────────────────────────────────────

    @SuppressLint("MissingPermission")
    @PluginMethod
    fun printReceipt(call: PluginCall) {
        val address = call.getString("address") ?: run { call.reject("address required"); return }
        val lines   = call.getArray("lines")    ?: run { call.reject("lines required"); return }
        if (missingConnectPermission()) { call.reject("Bluetooth permission denied"); return }

        val bytes = try {
            encodeEscPos(lines)
        } catch (e: Exception) {
            call.reject("Receipt encoding failed: ${e.message}"); return
        }

        // Socket IO off the calling thread; Capacitor calls are thread-safe to resolve.
        Thread {
            var socket: BluetoothSocket? = null
            try {
                val adapter = (activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
                    ?: throw IllegalStateException("Bluetooth unavailable")
                if (!adapter.isEnabled) throw IllegalStateException("Bluetooth is off")
                val device = adapter.getRemoteDevice(address)
                adapter.cancelDiscovery()
                socket = device.createRfcommSocketToServiceRecord(SPP_UUID)
                socket.connect()
                socket.outputStream.use { out ->
                    out.write(bytes)
                    out.flush()
                    // Cheap printers drop tail bytes if the socket closes immediately.
                    Thread.sleep(400)
                }
                call.resolve(JSObject().apply { put("printed", true); put("status", 0) })
            } catch (e: Exception) {
                call.resolve(JSObject().apply {
                    put("printed", false)
                    put("status", -1)
                    put("error", e.message ?: "Print failed")
                })
            } finally {
                try { socket?.close() } catch (_: Exception) {}
            }
        }.start()
    }

    // ── ESC/POS encoding ──────────────────────────────────────────────────────

    private fun encodeEscPos(lines: JSArray): ByteArray {
        val out = ByteArrayOutputStream()
        // CP437 is the near-universal thermal default; ISO-8859-1 as a fallback
        // keeps Western European characters at the right code points on many
        // clones. Anything beyond that prints approximately — acceptable here.
        val charset = try { Charset.forName("IBM437") } catch (_: Exception) { Charsets.ISO_8859_1 }

        out.write(byteArrayOf(0x1B, 0x40)) // ESC @ — initialize
        for (i in 0 until lines.length()) {
            val line = lines.getJSONObject(i)
            when (line.optString("kind")) {
                "image" -> {
                    val b64 = line.optString("imageB64")
                    if (b64.isNotEmpty()) {
                        val data = Base64.decode(b64, Base64.DEFAULT)
                        val bmp = BitmapFactory.decodeByteArray(data, 0, data.size)
                        if (bmp != null) {
                            out.write(byteArrayOf(0x1B, 0x61, 0x01)) // center
                            writeRaster(out, bmp)
                            out.write(byteArrayOf(0x1B, 0x61, 0x00))
                        }
                    }
                }
                "space" -> out.write('\n'.code)
                else -> {
                    val align: Byte = when (line.optString("align")) {
                        "center" -> 0x01; "right" -> 0x02; else -> 0x00
                    }
                    out.write(byteArrayOf(0x1B, 0x61, align)) // ESC a — alignment
                    val doubleHeight = line.optBoolean("doubleHeight")
                    if (doubleHeight) out.write(byteArrayOf(0x1D, 0x21, 0x01)) // GS ! — double height
                    var text = line.optString("text", "")
                    if (!text.endsWith("\n")) text += "\n"
                    out.write(text.toByteArray(charset))
                    if (doubleHeight) out.write(byteArrayOf(0x1D, 0x21, 0x00))
                }
            }
        }
        out.write(byteArrayOf(0x1B, 0x64, 0x03)) // ESC d — feed 3 lines clear of the tear bar
        return out.toByteArray()
    }

    /** GS v 0 raster image, thresholded to 1-bit (logo comes pre-flattened on white). */
    private fun writeRaster(out: ByteArrayOutputStream, bmp: Bitmap) {
        val width = bmp.width.coerceAtMost(MAX_DOTS)
        val height = bmp.height
        val bytesPerRow = (width + 7) / 8
        out.write(
            byteArrayOf(
                0x1D, 0x76, 0x30, 0x00,
                (bytesPerRow and 0xFF).toByte(), ((bytesPerRow shr 8) and 0xFF).toByte(),
                (height and 0xFF).toByte(), ((height shr 8) and 0xFF).toByte(),
            ),
        )
        val row = ByteArray(bytesPerRow)
        for (y in 0 until height) {
            row.fill(0)
            for (x in 0 until width) {
                val p = bmp.getPixel(x, y)
                val lum = 0.299 * ((p shr 16) and 0xFF) + 0.587 * ((p shr 8) and 0xFF) + 0.114 * (p and 0xFF)
                if (lum < 128) row[x / 8] = (row[x / 8].toInt() or (0x80 shr (x % 8))).toByte()
            }
            out.write(row)
        }
    }
}
