package work.nado.aidev.runner

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * The runner's state and controls (시작 · 정지 · 다시 시작), every permission it needs for running all the time — each
 * with its state and a button that asks for it or opens the system setting — pairing, updates and the log.
 */
class MainActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            render()
            main.postDelayed(this, 2000)
        }
    }

    /** A permission the runner needs to keep running here: whether it is granted, and how to ask for it. */
    private class Perm(val title: String, val why: String, val granted: () -> Boolean, val ask: () -> Unit)

    private lateinit var perms: List<Perm>
    private var updateUrl: String? = null

    private fun v(id: Int): View = findViewById(id)
    private fun t(id: Int): TextView = findViewById(id)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        val pkg = Uri.parse("package:$packageName")
        perms = listOfNotNull(
            Perm("알림", "연결 상태를 알림에 보여 줍니다 — 알림이 있어야 Android가 서비스를 멈추지 않습니다",
                { Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED },
                { if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1) }),
            Perm("배터리 최적화 제외", "화면이 꺼지거나 절전(Doze) 중에도 연결을 끊지 않습니다",
                { (getSystemService(POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName) },
                { open(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg), Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }),
            Perm("백그라운드 데이터", "데이터 절약 모드에서도 앱이 보이지 않을 때 연결을 유지합니다",
                { (getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager).restrictBackgroundStatus != ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED },
                { open(Intent(Settings.ACTION_IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS, pkg)) }),
            Perm("저장소 전체 접근", "에이전트가 공유 저장소(${Environment.getExternalStorageDirectory().absolutePath})의 파일을 읽고 씁니다 — 허용하면 허용 폴더에 추가합니다",
                { storageGranted() },
                {
                    if (Build.VERSION.SDK_INT >= 30) open(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, pkg), Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
                    else requestPermissions(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE), 2)
                }),
        )

        v(R.id.start).setOnClickListener { askMissingThen { RunnerService.start(this) }; render() }
        v(R.id.stop).setOnClickListener { RunnerService.stop(this); render() }
        v(R.id.restart).setOnClickListener { RunnerService.start(this, restart = true); render() }
        (v(R.id.boot) as Switch).apply {
            isChecked = Prefs.bootStart(this@MainActivity)
            setOnCheckedChangeListener { _, on -> Prefs.setBootStart(this@MainActivity, on) }
        }
        (v(R.id.awake) as Switch).apply {
            isChecked = Prefs.keepAwake(this@MainActivity)
            setOnCheckedChangeListener { _, on ->
                Prefs.setKeepAwake(this@MainActivity, on)
                if (RunnerService.running) RunnerService.start(this@MainActivity)   // holds or lets go of the locks
            }
        }
        v(R.id.appinfo).setOnClickListener { open(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)) }
        v(R.id.pair).setOnClickListener { pair() }
        v(R.id.unpair).setOnClickListener { unpair() }
        v(R.id.update).setOnClickListener { updateUrl?.let { open(Intent(Intent.ACTION_VIEW, Uri.parse(it))) } ?: checkUpdate() }
        v(R.id.reloadLog).setOnClickListener { t(R.id.log).text = Runner.tail(this, 80) }
        (v(R.id.gateway) as EditText).setText(Runner.config(this)?.gateway ?: Runner.DEFAULT_GATEWAY)
        t(R.id.version).text = "이 앱 ${BuildConfig.VERSION_NAME} (러너 같은 버전)"
        fromLink(intent)
        checkUpdate()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        fromLink(intent)
    }

    override fun onResume() {
        super.onResume()
        main.post(tick)
        t(R.id.log).text = Runner.tail(this, 80)
        shareStorage()
    }

    override fun onPause() {
        main.removeCallbacks(tick)
        super.onPause()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        render()
        if (requestCode == 2) shareStorage()
    }

    /** nadovibe-runner://pair?code=…&gateway=… : the pairing fields filled in. */
    private fun fromLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "nadovibe-runner") return
        uri.getQueryParameter("code")?.let { (v(R.id.code) as EditText).setText(it) }
        uri.getQueryParameter("gateway")?.let { (v(R.id.gateway) as EditText).setText(it) }
        t(R.id.pairResult).text = "코드를 받았습니다 — 페어링을 누르세요"
    }

    private fun open(vararg intents: Intent) {
        for (i in intents) {
            try {
                startActivity(i)
                return
            } catch (_: ActivityNotFoundException) {
            } catch (_: SecurityException) {
            }
        }
        // a TV box or panel without that settings screen: the app's own page, where most of them are
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            Toast.makeText(this, "이 기기에는 그 설정 화면이 없습니다 — 앱 정보에서 설정하세요", Toast.LENGTH_LONG).show()
        } catch (_: Exception) {
            Toast.makeText(this, "설정 화면을 열 수 없습니다", Toast.LENGTH_LONG).show()
        }
    }

    private fun storageGranted() = if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager()
        else checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

    /** Shared storage granted: the runner may use it (an allowed folder), from its next start. */
    private fun shareStorage() {
        val cfg = Runner.config(this) ?: return
        val root = Environment.getExternalStorageDirectory().absolutePath
        if (!storageGranted() || root in cfg.roots) return
        Thread {
            val (code, out) = Runner.command(this, "roots", "add", root)
            main.post {
                if (code == 0) {
                    Toast.makeText(this, "허용 폴더에 $root 를 추가했습니다", Toast.LENGTH_SHORT).show()
                    if (RunnerService.running) RunnerService.start(this, restart = true)
                } else t(R.id.problem).apply { text = "허용 폴더 추가 실패: $out"; visibility = View.VISIBLE }
            }
        }.start()
    }

    /** Starts it, and asks for notifications when they are off (the service's notification is how it stays alive). */
    private fun askMissingThen(go: () -> Unit) {
        go()
        perms.first().takeIf { !it.granted() }?.ask?.invoke()
    }

    private fun render() {
        val cfg = Runner.config(this)
        val state = Runner.state(this)
        val (text, color) = when {
            cfg == null -> "페어링 필요" to R.color.warn
            state == "connected" -> "연결됨" to R.color.ok
            state == "connecting" -> "연결 중…" to R.color.warn
            RunnerService.running -> "시작 중…" to R.color.warn
            else -> "꺼짐" to R.color.bad
        }
        t(R.id.state).apply { this.text = text; setTextColor(getColor(color)) }
        t(R.id.target).text = cfg?.let { "#${it.targetId} ${it.name}\n${it.gateway}\n허용 폴더: ${it.roots.joinToString(", ")}" } ?: "작업대 \"원격 대상 → 등록\"에서 코드를 받아 아래에 넣으세요"
        t(R.id.problem).apply {
            val p = RunnerService.problem
            this.text = p ?: ""
            visibility = if (p == null) View.GONE else View.VISIBLE
        }
        v(R.id.start).isEnabled = cfg != null && !RunnerService.running
        v(R.id.stop).isEnabled = RunnerService.running
        v(R.id.restart).isEnabled = RunnerService.running
        v(R.id.unpair).isEnabled = cfg != null
        renderPerms()
    }

    private fun renderPerms() {
        val box = v(R.id.perms) as LinearLayout
        box.removeAllViews()
        val dp = resources.displayMetrics.density
        for (p in perms) {
            val ok = p.granted()
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, (6 * dp).toInt(), 0, (6 * dp).toInt())
            }
            row.addView(TextView(this).apply {
                text = if (ok) "✓" else "✗"
                textSize = 18f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(getColor(if (ok) R.color.ok else R.color.bad))
                minWidth = (28 * dp).toInt()
            })
            row.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                addView(TextView(this@MainActivity).apply { text = p.title; textSize = 15f; setTypeface(typeface, Typeface.BOLD) })
                addView(TextView(this@MainActivity).apply { text = p.why; textSize = 12f; setTextColor(getColor(R.color.muted)) })
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            if (!ok) row.addView(Button(this).apply { text = "허용"; setOnClickListener { p.ask() } })
            box.addView(row)
        }
    }

    private fun pair() {
        val code = (v(R.id.code) as EditText).text.toString().trim()
        val gateway = (v(R.id.gateway) as EditText).text.toString().trim().ifEmpty { Runner.DEFAULT_GATEWAY }
        val name = (v(R.id.name) as EditText).text.toString().trim()
        if (code.isEmpty()) { t(R.id.pairResult).text = "페어링 코드를 입력하세요"; return }
        t(R.id.pairResult).text = "페어링 중…"
        v(R.id.pair).isEnabled = false
        Thread {
            val wasRunning = RunnerService.running
            val args = mutableListOf("pair", code, "--gateway", gateway)
            if (name.isNotEmpty()) args += listOf("--name", name)
            val (exit, out) = Runner.command(this, *args.toTypedArray())
            main.post {
                v(R.id.pair).isEnabled = true
                t(R.id.pairResult).text = out.lineSequence().firstOrNull { it.isNotBlank() } ?: "exit $exit"
                if (exit == 0) {
                    (v(R.id.code) as EditText).setText("")
                    RunnerService.problem = null
                    shareStorage()
                    // the running runner still holds the old token: start it again with the new one
                    askMissingThen { RunnerService.start(this, restart = wasRunning) }
                }
                render()
            }
        }.start()
    }

    private fun unpair() {
        RunnerService.stop(this)
        Thread {
            val (_, out) = Runner.command(this, "unpair")
            main.post { t(R.id.pairResult).text = out.lineSequence().firstOrNull() ?: ""; render() }
        }.start()
    }

    /** The newest Android version the gateway offers (/_runner/versions?platform=android), when newer than this app. */
    private fun checkUpdate() {
        val gateway = Runner.config(this)?.gateway ?: (v(R.id.gateway) as EditText).text.toString().trim().ifEmpty { Runner.DEFAULT_GATEWAY }
        val button = v(R.id.update) as Button
        button.isEnabled = false
        Thread {
            val result = try {
                val c = URL("${gateway.trimEnd('/')}/_runner/versions?platform=android").openConnection() as HttpURLConnection
                c.connectTimeout = 10_000
                c.readTimeout = 10_000
                val body = c.inputStream.bufferedReader().readText()
                val list = JSONObject(body).getJSONArray("versions")
                if (list.length() == 0) null else list.getJSONObject(0)
            } catch (_: Exception) {
                null
            }
            main.post {
                button.isEnabled = true
                val ver = result?.optString("version")
                if (ver != null && newer(ver, BuildConfig.VERSION_NAME)) {
                    val url = result.optString("url")
                    updateUrl = if (url.startsWith("/")) gateway.trimEnd('/') + url else url
                    button.text = "업데이트 $ver 받기"
                    t(R.id.version).text = "이 앱 ${BuildConfig.VERSION_NAME} → 새 버전 $ver (받은 APK를 열어 설치 — 페어링·설정은 그대로)"
                } else {
                    updateUrl = null
                    button.text = "새 버전 확인"
                    t(R.id.version).text = "이 앱 ${BuildConfig.VERSION_NAME}" + if (result != null) " — 최신입니다" else ""
                }
            }
        }.start()
    }

    private fun newer(a: String, b: String): Boolean {
        val x = a.split('.').map { it.toIntOrNull() ?: 0 }
        val y = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) {
            val d = (x.getOrElse(i) { 0 }) - (y.getOrElse(i) { 0 })
            if (d != 0) return d > 0
        }
        return false
    }
}
