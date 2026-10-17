package work.nado.aidev.runner

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import java.io.FileOutputStream

/**
 * Keeps `aidev-runner start` running: a foreground service (its notification shows the connection and offers 정지),
 * the runner as a child process started again after it ends — 5 s, doubling to 60 s, back to 5 s after a minute of
 * running — until the owner stops it or the gateway refuses the token (exit 3: pair again). START_STICKY and the boot
 * receiver bring it back after Android or a reboot ends it. Stopping sends SIGTERM: the runner stops the commands it
 * runs and ends (exit 0).
 */
class RunnerService : Service() {
    companion object {
        const val ACTION_STOP = "work.nado.aidev.runner.STOP"
        const val ACTION_RESTART = "work.nado.aidev.runner.RESTART"
        private const val CHANNEL = "runner"
        private const val NOTIFICATION = 1

        /** Why the runner is not running when it should be (shown in the app), or null. */
        @Volatile var problem: String? = null
        @Volatile var running = false

        fun start(ctx: Context, restart: Boolean = false) {
            Prefs.setEnabled(ctx, true)
            val i = Intent(ctx, RunnerService::class.java).apply { if (restart) action = ACTION_RESTART }
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            Prefs.setEnabled(ctx, false)
            ctx.stopService(Intent(ctx, RunnerService::class.java))
        }
    }

    @Volatile private var wanted = false
    @Volatile private var quick = false
    @Volatile private var process: Process? = null
    private var worker: Thread? = null
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private val main = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            notifyState()
            main.postDelayed(this, 3000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Prefs.setEnabled(this, false)
            stopSelf()
            return START_NOT_STICKY
        }
        foreground(notification("연결 준비 중…"))
        if (Runner.config(this) == null) {
            problem = "페어링이 필요합니다 — 앱에서 페어링 코드를 입력하세요"
            stopSelf()
            return START_NOT_STICKY
        }
        problem = null
        holdLocks()
        if (intent?.action == ACTION_RESTART) {
            quick = true
            terminate()
        }
        if (worker?.isAlive != true) {
            wanted = true
            worker = Thread(::loop, "aidev-runner").apply { start() }
        }
        main.removeCallbacks(refresh)
        main.post(refresh)
        return START_STICKY
    }

    private fun loop() {
        running = true
        var backoff = 5_000L
        while (wanted) {
            val started = SystemClock.elapsedRealtime()
            val code = try {
                val p = Runner.builder(this, "start", "--service", "--log", Runner.log(this).absolutePath).start()
                process = p
                p.outputStream.close()
                // what it says before it points its output at the log (a start-up error)
                Runner.dir(this).mkdirs()
                FileOutputStream(Runner.log(this), true).use { out -> p.inputStream.copyTo(out) }
                p.waitFor()
            } catch (e: Exception) {
                problem = "러너를 실행하지 못했습니다: ${e.message}"
                -1
            } finally {
                process = null
            }
            if (!wanted) break
            if (code == 3) {
                problem = "게이트웨이가 이 기기의 토큰을 거부했습니다 (대상이 삭제됐거나 다시 페어링됨) — 새 코드로 페어링하세요"
                wanted = false
                Prefs.setEnabled(this, false)
                break
            }
            if (SystemClock.elapsedRealtime() - started > 60_000) backoff = 5_000L
            val wait = if (quick) 300L else backoff
            quick = false
            var slept = 0L
            while (wanted && slept < wait && !quick) { Thread.sleep(100); slept += 100 }
            backoff = (backoff * 2).coerceAtMost(60_000L)
        }
        running = false
        main.post { if (!wanted) stopSelf() }
    }

    /** SIGTERM to the runner (it ends its commands and exits), SIGKILL after 8 s. */
    private fun terminate() {
        val p = process ?: return
        Runner.pid(this)?.let { android.os.Process.sendSignal(it, 15) } ?: p.destroy()
        Thread {
            if (!Runner.waitFor(p, 8)) p.destroy()
        }.start()
    }

    override fun onDestroy() {
        wanted = false
        terminate()
        main.removeCallbacks(refresh)
        wake?.takeIf { it.isHeld }?.release()
        wifi?.takeIf { it.isHeld }?.release()
        running = false
        super.onDestroy()
    }

    private fun holdLocks() {
        if (!Prefs.keepAwake(this)) {
            wake?.takeIf { it.isHeld }?.release()
            wifi?.takeIf { it.isHeld }?.release()
            return
        }
        if (wake?.isHeld != true) {
            wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nadovibe:runner").apply { setReferenceCounted(false); acquire() }
        }
        if (wifi?.isHeld != true) {
            val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifi = (applicationContext.getSystemService(WIFI_SERVICE) as? WifiManager)?.createWifiLock(mode, "nadovibe:runner")?.apply { setReferenceCounted(false); acquire() }
        }
    }

    private fun stateText(): String {
        val cfg = Runner.config(this)
        val target = cfg?.let { " · #${it.targetId} ${it.name}" } ?: ""
        return when (Runner.state(this)) {
            "connected" -> "연결됨$target"
            "paused" -> "정지됨$target"
            "connecting" -> "연결 중…$target"
            else -> problem ?: "시작 중…$target"
        }
    }

    private fun notifyState() {
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION, notification(stateText()))
    }

    private fun notification(text: String): Notification {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "러너 연결", NotificationManager.IMPORTANCE_LOW).apply {
                description = "NadoVibe 러너가 실행 중인 동안 연결 상태를 보여 줍니다"
                setShowBadge(false)
            })
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), flags)
        val stop = PendingIntent.getService(this, 1, Intent(this, RunnerService::class.java).setAction(ACTION_STOP), flags)
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        return b.setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("NadoVibe 러너")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(Notification.Action.Builder(null, "정지", stop).build())
            .build()
    }

    private fun foreground(n: Notification) {
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(NOTIFICATION, n)
    }
}
