package work.nado.aidev.runner

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** After a reboot (when "부팅 시 자동 시작" is on) and after the app is updated: the runner again, if it was running. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val boot = intent.action != Intent.ACTION_MY_PACKAGE_REPLACED
        if (!Prefs.enabled(ctx) || (boot && !Prefs.bootStart(ctx)) || Runner.config(ctx) == null) return
        try {
            RunnerService.start(ctx)
        } catch (e: Exception) {
            RunnerService.problem = "자동 시작 실패: ${e.message}"
        }
    }
}
