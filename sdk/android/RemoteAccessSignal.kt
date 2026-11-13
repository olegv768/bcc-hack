package kz.example.dropperguard

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import java.util.concurrent.Executor
import java.util.function.Consumer

/**
 * Признак «телефоном могут управлять удалённо»: мошенник просит установить AnyDesk или похожую
 * программу и сам ведёт перевод с чужого экрана.
 *
 * Три проверки, ни одна не показывает клиенту диалог разрешения:
 *   1. controlEnabled — включена служба специальных возможностей программы удалённого доступа.
 *      Через такую службу программа нажимает на экран за человека. Самый сильный признак.
 *   2. screenRecorded — экран приложения сейчас записывается или транслируется (Android 15+,
 *      нужна строка DETECT_SCREEN_RECORDING в манифесте; она выдаётся при установке).
 *   3. installedApps — известные программы удалённого доступа установлены. Слабый признак:
 *      программа может стоять у человека по работе.
 *
 * В манифест приложения нужно добавить блок <queries> — см. sdk/android-test/app/src/main/AndroidManifest.xml.
 *
 *   val remote = RemoteAccessSignal.check(context)
 *   val active = remote.controlEnabled            // положить в запрос перевода как remote_access_active
 */
object RemoteAccessSignal {

    /** Список ведёт банк: программы появляются и переименовываются. */
    val KNOWN_APPS: Map<String, String> = mapOf(
        "com.anydesk.anydeskandroid" to "AnyDesk",
        "com.carriez.flutter_hbb" to "RustDesk",
        "com.teamviewer.quicksupport.market" to "TeamViewer QuickSupport",
        "com.teamviewer.host.market" to "TeamViewer Host",
        "com.sand.airdroid" to "AirDroid",
    )

    /** Службы управления ставятся отдельными пакетами-дополнениями, поэтому сверяем по началу имени. */
    private val KNOWN_PREFIXES = listOf("com.anydesk.", "com.carriez.flutter_hbb", "com.teamviewer.", "com.sand.air")

    data class Result(
        val controlEnabled: Boolean,
        val controlServices: List<String>,
        val installedApps: List<String>,
    )

    fun check(context: Context): Result {
        val accessibility = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        val services = accessibility
            .getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .mapNotNull { it.resolveInfo?.serviceInfo?.packageName }
            .filter { name -> KNOWN_PREFIXES.any { name.startsWith(it) } }
            .distinct()

        val installed = KNOWN_APPS.filterKeys { isInstalled(context, it) }.values.toList()

        return Result(controlEnabled = services.isNotEmpty(), controlServices = services, installedApps = installed)
    }

    /**
     * Сообщает, когда экран этого приложения начинают и перестают записывать или транслировать.
     * Работает на Android 15+; на более старых версиях ничего не делает.
     * Возвращает функцию отписки; вызвать её в onStop().
     */
    fun watchScreenRecording(activity: Activity, executor: Executor, onChange: (Boolean) -> Unit): () -> Unit {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) return {}
        val callback = Consumer<Int> { state -> onChange(state == WindowManager.SCREEN_RECORDING_STATE_VISIBLE) }
        val initial = activity.windowManager.addScreenRecordingCallback(executor, callback)
        onChange(initial == WindowManager.SCREEN_RECORDING_STATE_VISIBLE)
        return { activity.windowManager.removeScreenRecordingCallback(callback) }
    }

    private fun isInstalled(context: Context, packageName: String): Boolean =
        try {
            context.packageManager.getPackageInfo(packageName, 0)
            true
        } catch (e: PackageManager.NameNotFoundException) {
            false
        }
}
