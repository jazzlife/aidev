package work.nado.aidev.runner

import android.content.Context
import android.os.Build
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The aidev-runner binary in this app (lib/<abi>/libaidevrunner.so — a program, packaged as a native library so Android
 * extracts it executable) and what it keeps in the app's files folder: HOME is filesDir, so its config is
 * files/.aidev/runner.toml, its log files/.aidev/runner.log and its state files/.aidev/state ("connected <pid>").
 */
object Runner {
    const val DEFAULT_GATEWAY = "https://dev.nado.work"

    fun exe(ctx: Context) = File(ctx.applicationInfo.nativeLibraryDir, "libaidevrunner.so")
    fun dir(ctx: Context) = File(ctx.filesDir, ".aidev")
    fun log(ctx: Context) = File(dir(ctx), "runner.log")

    /** The runner's environment: a home in the app's sandbox, Android's shell, and this device's model as its host name. */
    fun env(ctx: Context): Map<String, String> = mapOf(
        "HOME" to ctx.filesDir.absolutePath,
        "TMPDIR" to ctx.cacheDir.absolutePath,
        "SHELL" to "/system/bin/sh",
        "USER" to "android",
        "HOSTNAME" to Build.MODEL.replace(Regex("[^A-Za-z0-9._-]+"), "-").trim('-').ifEmpty { "android" },
        "AIDEV_NO_TRAY" to "1",
    )

    fun builder(ctx: Context, vararg args: String): ProcessBuilder =
        ProcessBuilder(listOf(exe(ctx).absolutePath) + args).directory(ctx.filesDir).redirectErrorStream(true)
            .also { it.environment().putAll(env(ctx)) }

    /** `aidev-runner <args>` to its end (at most `timeoutSec`): exit code and output. Off the main thread. */
    fun command(ctx: Context, vararg args: String, timeoutSec: Long = 60): Pair<Int, String> = try {
        val p = builder(ctx, *args).start()
        p.outputStream.close()
        val out = StringBuilder()
        val reader = Thread { out.append(p.inputStream.bufferedReader().readText()) }.apply { start() }
        val code = if (waitFor(p, timeoutSec)) p.exitValue() else { p.destroy(); -1 }
        reader.join(2000)
        code to out.toString().trim()
    } catch (e: Exception) {
        -1 to (e.message ?: e.toString())
    }

    /** Process.waitFor(timeout) is API 26; this is the same for 24. */
    fun waitFor(p: Process, timeoutSec: Long): Boolean {
        val end = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSec)
        while (System.nanoTime() < end) {
            if (!alive(p)) return true
            Thread.sleep(100)
        }
        return !alive(p)
    }

    fun alive(p: Process) = try { p.exitValue(); false } catch (_: IllegalThreadStateException) { true }

    data class Config(val gateway: String, val targetId: Long, val name: String, val roots: List<String>, val screen: Boolean)

    /** runner.toml, read for display (the runner writes it; the token is never read here). */
    fun config(ctx: Context): Config? {
        val text = File(dir(ctx), "runner.toml").takeIf { it.isFile }?.readText() ?: return null
        fun str(key: String) = Regex("""(?m)^$key\s*=\s*"((?:[^"\\]|\\.)*)"""").find(text)?.groupValues?.get(1)?.replace("\\\"", "\"")?.replace("\\\\", "\\")
        val roots = Regex("""(?s)allowed_roots\s*=\s*\[(.*?)]""").find(text)?.groupValues?.get(1)
            ?.let { Regex(""""((?:[^"\\]|\\.)*)"""").findAll(it).map { m -> m.groupValues[1] }.toList() } ?: emptyList()
        return Config(
            gateway = str("gateway") ?: return null,
            targetId = Regex("""(?m)^target_id\s*=\s*(\d+)""").find(text)?.groupValues?.get(1)?.toLongOrNull() ?: 0,
            name = str("name") ?: "",
            roots = roots,
            screen = Regex("""(?m)^screen_consent\s*=\s*true""").containsMatchIn(text),
        )
    }

    /** The runner's own word for its connection ("connected", "connecting", "paused") while its process lives. */
    fun state(ctx: Context): String? {
        val words = File(dir(ctx), "state").takeIf { it.isFile }?.readText()?.trim()?.split(Regex("\\s+")) ?: return null
        val pid = words.getOrNull(1)?.toIntOrNull() ?: return null
        return if (File("/proc/$pid").exists()) words[0] else null
    }

    /** The pid of the running runner (from its state file). */
    fun pid(ctx: Context): Int? =
        File(dir(ctx), "state").takeIf { it.isFile }?.readText()?.trim()?.split(Regex("\\s+"))?.getOrNull(1)?.toIntOrNull()
            ?.takeIf { File("/proc/$it").exists() }

    fun tail(ctx: Context, lines: Int): String {
        val f = log(ctx)
        if (!f.isFile) return "(로그 없음)"
        return f.readLines().takeLast(lines).joinToString("\n")
    }
}

/** The app's own settings. */
object Prefs {
    private fun p(ctx: Context) = ctx.getSharedPreferences("runner", Context.MODE_PRIVATE)
    /** The runner should be running (started and not stopped by the owner): the boot receiver starts it again. */
    fun enabled(ctx: Context) = p(ctx).getBoolean("enabled", false)
    fun setEnabled(ctx: Context, on: Boolean) = p(ctx).edit().putBoolean("enabled", on).apply()
    fun bootStart(ctx: Context) = p(ctx).getBoolean("boot", true)
    fun setBootStart(ctx: Context, on: Boolean) = p(ctx).edit().putBoolean("boot", on).apply()
    /** Keep the CPU and Wi-Fi awake while the screen is off (a plugged-in board or panel: on). */
    fun keepAwake(ctx: Context) = p(ctx).getBoolean("awake", true)
    fun setKeepAwake(ctx: Context, on: Boolean) = p(ctx).edit().putBoolean("awake", on).apply()
}
