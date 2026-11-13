package kz.example.dropperguard.test

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kz.example.dropperguard.CallSignal
import kz.example.dropperguard.RemoteAccessSignal
import kz.example.dropperguard.TransferWarning
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Проверка модуля на настоящем телефоне: видит ли он звонок и программу удалённого доступа.
 * Экран раз в секунду опрашивает модуль и пишет в журнал каждое изменение.
 */
class MainActivity : Activity() {

    private val handler = Handler(Looper.getMainLooper())
    private val time = SimpleDateFormat("HH:mm:ss", Locale.US)

    private lateinit var callCard: SignalCard
    private lateinit var remoteCard: SignalCard
    private lateinit var log: TextView
    private lateinit var logEmpty: TextView

    private var lastOnCall: Boolean? = null
    private var lastRemote: Boolean? = null
    private var screenRecorded = false
    private var stopWatchingCall: () -> Unit = {}
    private var stopWatchingScreen: () -> Unit = {}

    private val poll = object : Runnable {
        override fun run() {
            refresh("опрос")
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = PAPER
        window.navigationBarColor = PAPER
        window.decorView.systemUiVisibility =
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR

        callCard = SignalCard("Звонок")
        remoteCard = SignalCard("Удалённый доступ")
        log = text(13f, INK).apply {
            typeface = Typeface.MONOSPACE
            setLineSpacing(dp(4).toFloat(), 1f)
        }
        logEmpty = text(14f, MUTED).apply { text = "Изменений пока не было. Позвоните кому-нибудь и вернитесь сюда." }

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(20), dp(16), dp(24))
            fitsSystemWindows = true

            addView(text(24f, INK, bold = true).apply { text = "Проверка сигналов" })
            addView(text(14f, MUTED).apply {
                text = "${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE}\n" +
                    "Приложение не запрашивает ни одного разрешения."
            }, spaced(4))

            addView(callCard.view, spaced(18))
            addView(remoteCard.view, spaced(12))

            addView(button("Показать предупреждение клиенту", filled = true) { showWarning() }, spaced(18))

            val journal = card().apply {
                addView(LinearLayout(context).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    addView(text(16f, INK, bold = true).apply { text = "Журнал изменений" },
                        LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                    addView(text(14f, ACCENT, bold = true).apply {
                        text = "Очистить"
                        setPadding(dp(8), dp(8), 0, dp(8))
                        setOnClickListener { log.text = ""; logEmpty.visibility = View.VISIBLE }
                    })
                })
                addView(logEmpty, spaced(4))
                addView(log, spaced(4))
            }
            addView(journal, spaced(18))
        }

        setContentView(ScrollView(this).apply {
            setBackgroundColor(PAPER)
            addView(content)
        })
    }

    override fun onStart() {
        super.onStart()
        handler.post(poll)
        // На Android 12+ звонок приходит ещё и через слушатель — сразу, без ожидания опроса.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            stopWatchingCall = CallSignal.watch(this, mainExecutor) { refresh("слушатель") }
        }
        // На Android 15+ система сама сообщает, что экран приложения записывают или транслируют.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            stopWatchingScreen = RemoteAccessSignal.watchScreenRecording(this, mainExecutor) { recorded ->
                screenRecorded = recorded
                refresh("запись экрана")
            }
        }
    }

    override fun onStop() {
        super.onStop()
        handler.removeCallbacks(poll)
        stopWatchingCall()
        stopWatchingScreen()
        stopWatchingCall = {}
        stopWatchingScreen = {}
    }

    private fun refresh(source: String) {
        val onCall = CallSignal.isOnCall(this)
        val mode = (getSystemService(Context.AUDIO_SERVICE) as AudioManager).mode
        callCard.show(
            alarm = onCall,
            state = if (onCall) "Идёт разговор" else "Разговора нет",
            detail = "Режим звука: ${modeName(mode)}",
        )
        if (onCall != lastOnCall) {
            lastOnCall = onCall
            addLog("звонок: ${if (onCall) "ДА" else "нет"} · ${modeName(mode)} · $source")
        }

        val remote = RemoteAccessSignal.check(this)
        val active = remote.controlEnabled || screenRecorded
        val details = mutableListOf<String>()
        if (remote.controlEnabled) details += "Служба управления включена: ${remote.controlServices.joinToString()}"
        if (screenRecorded) details += "Экран записывается или транслируется"
        details += if (remote.installedApps.isEmpty()) "Известных программ не установлено"
        else "Установлено: ${remote.installedApps.joinToString()}"
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            details += "Запись экрана на этой версии Android не определяется"
        }
        remoteCard.show(
            alarm = active,
            state = if (active) "Телефоном могут управлять" else "Не обнаружен",
            detail = details.joinToString("\n"),
        )
        if (active != lastRemote) {
            lastRemote = active
            addLog("удалённый доступ: ${if (active) "ДА" else "нет"} · $source")
        }
    }

    private fun addLog(line: String) {
        logEmpty.visibility = View.GONE
        log.text = "${time.format(Date())}  $line\n${log.text}"
    }

    private fun showWarning() {
        TransferWarning.show(
            context = this,
            action = "warn",
            title = "Вы сейчас разговариваете по телефону",
            body = "Сотрудники банка, полиции и госорганов не просят переводить деньги на «безопасный счёт». " +
                "Если вас торопят с переводом — положите трубку.",
            onCancel = { addLog("предупреждение: перевод отменён") },
            onProceed = { addLog("предупреждение: клиент продолжил") },
        )
    }

    private fun modeName(mode: Int): String = when (mode) {
        AudioManager.MODE_NORMAL -> "NORMAL"
        AudioManager.MODE_RINGTONE -> "RINGTONE"
        AudioManager.MODE_IN_CALL -> "IN_CALL"
        AudioManager.MODE_IN_COMMUNICATION -> "IN_COMMUNICATION"
        AudioManager.MODE_CALL_SCREENING -> "CALL_SCREENING"
        AudioManager.MODE_CALL_REDIRECT -> "CALL_REDIRECT"
        AudioManager.MODE_COMMUNICATION_REDIRECT -> "COMMUNICATION_REDIRECT"
        else -> "другой ($mode)"
    }

    // --- оформление: без библиотек, чтобы пример оставался маленьким ---

    /** Карточка одного сигнала: название, состояние с цветной точкой, пояснение. */
    private inner class SignalCard(title: String) {
        private val dot = View(this@MainActivity)
        private val state = text(22f, INK, bold = true)
        private val detail = text(14f, MUTED)
        val view: LinearLayout = card().apply {
            addView(text(13f, MUTED).apply { text = title })
            addView(LinearLayout(context).apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(dot, LinearLayout.LayoutParams(dp(12), dp(12)).apply { rightMargin = dp(10) })
                addView(state)
            }, spaced(6))
            addView(detail, spaced(6))
        }

        fun show(alarm: Boolean, state: String, detail: String) {
            dot.background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(if (alarm) ALARM else CALM)
            }
            view.background = rounded(if (alarm) ALARM_BG else SURFACE, if (alarm) ALARM else LINE)
            this.state.text = state
            this.state.setTextColor(if (alarm) ALARM_INK else INK)
            this.detail.text = detail
        }
    }

    private fun card() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(14), dp(16), dp(16))
        background = rounded(SURFACE, LINE)
    }

    private fun rounded(fill: Int, stroke: Int) = GradientDrawable().apply {
        cornerRadius = dp(14).toFloat()
        setColor(fill)
        setStroke(dp(1), stroke)
    }

    private fun text(size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        textSize = size
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }

    private fun button(label: String, filled: Boolean, onClick: () -> Unit) = TextView(this).apply {
        text = label
        textSize = 16f
        gravity = Gravity.CENTER
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(if (filled) Color.WHITE else INK)
        minHeight = dp(52)
        background = GradientDrawable().apply {
            cornerRadius = dp(12).toFloat()
            setColor(if (filled) ACCENT else SURFACE)
        }
        setOnClickListener { onClick() }
    }

    private fun spaced(top: Int) = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(top) }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private companion object {
        val PAPER = Color.rgb(0xF4, 0xF2, 0xEA)
        val SURFACE = Color.rgb(0xFC, 0xFC, 0xFB)
        val INK = Color.rgb(0x16, 0x15, 0x0F)
        val MUTED = Color.rgb(0x5E, 0x5C, 0x56)
        val LINE = Color.rgb(0xD9, 0xD6, 0xCB)
        val ACCENT = Color.rgb(0x0E, 0x5A, 0x52)
        val CALM = Color.rgb(0x1E, 0x8A, 0x3C)
        val ALARM = Color.rgb(0xD0, 0x3B, 0x3B)
        val ALARM_BG = Color.rgb(0xFB, 0xE9, 0xE9)
        val ALARM_INK = Color.rgb(0x7A, 0x14, 0x14)
    }
}
