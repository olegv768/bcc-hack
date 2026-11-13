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
import android.view.WindowInsets
import android.widget.FrameLayout
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

    private lateinit var callTile: SignalTile
    private lateinit var remoteTile: SignalTile
    private lateinit var journal: LinearLayout
    private lateinit var journalEmpty: TextView

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
        window.statusBarColor = NAVY
        window.navigationBarColor = PAPER
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR

        callTile = SignalTile("Звонок")
        remoteTile = SignalTile("Удалённый доступ")
        journal = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        journalEmpty = text(15f, MUTED).apply {
            text = "Изменений пока не было. Позвоните кому-нибудь и вернитесь сюда."
        }

        // тёмная шапка: что это за экран и на каком телефоне идёт проверка
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(NAVY)
            setPadding(dp(22), dp(28), dp(22), dp(24))
            // на Android 15+ экран рисуется под строкой состояния: шапка уходит под неё, текст — ниже
            setOnApplyWindowInsetsListener { view, insets ->
                view.setPadding(dp(22), dp(28) + topInset(insets), dp(22), dp(24))
                insets
            }
            addView(text(30f, Color.WHITE, heavy = true).apply {
                text = "Что видит\nмодуль"
                setLineSpacing(0f, 1.05f)
                letterSpacing = -0.02f
            })
            addView(text(15f, Color.argb(190, 255, 255, 255)).apply {
                text = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}, Android ${Build.VERSION.RELEASE}. " +
                    "Ни одного разрешения приложение не запрашивает."
                setLineSpacing(dp(3).toFloat(), 1f)
            }, spaced(10))
        }

        // первая плитка наполовину заходит на тёмную шапку: под ней лежит полоса того же цвета
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            clipChildren = false
            setPadding(dp(14), 0, dp(14), dp(28))
            setOnApplyWindowInsetsListener { view, insets ->
                view.setPadding(dp(14), 0, dp(14), dp(28) + bottomInset(insets))
                insets
            }
            addView(callTile.view, spaced(0))
            addView(remoteTile.view, spaced(10))
            addView(button("Показать предупреждение клиенту") { showWarning() }, spaced(18))

            addView(LinearLayout(context).apply {
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(8), 0, dp(8), 0)
                addView(text(20f, INK, heavy = true).apply { text = "Журнал" },
                    LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                addView(text(15f, ACCENT, heavy = true).apply {
                    text = "Очистить"
                    setPadding(dp(12), dp(10), 0, dp(10))
                    setOnClickListener {
                        journal.removeAllViews()
                        journalEmpty.visibility = View.VISIBLE
                    }
                })
            }, spaced(28))
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(18), dp(16), dp(18), dp(16))
                background = rounded(SURFACE, 24)
                addView(journalEmpty)
                addView(journal)
            }, spaced(8))
        }

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            clipChildren = false
            addView(header)
            addView(FrameLayout(context).apply {
                addView(View(context).apply { setBackgroundColor(NAVY) }, FrameLayout.LayoutParams(MATCH_PARENT, dp(44)))
                addView(body)
            })
        }
        setContentView(ScrollView(this).apply {
            setBackgroundColor(PAPER)
            isFillViewport = true
            addView(content)
        })
    }

    override fun onStart() {
        super.onStart()
        refresh("запуск")
        handler.postDelayed(poll, 1000)
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
        callTile.show(
            alarm = onCall,
            state = if (onCall) "Идёт разговор" else "Разговора нет",
            detail = "Режим звука: ${modeName(mode)}",
        )
        if (onCall != lastOnCall) {
            lastOnCall = onCall
            addLog(onCall, if (onCall) "Начался разговор" else "Разговора нет", "${modeName(mode)}, $source")
        }

        val remote = RemoteAccessSignal.check(this)
        val active = remote.controlEnabled || screenRecorded
        val details = mutableListOf<String>()
        if (remote.controlEnabled) details += "Включена служба управления: ${remote.controlServices.joinToString()}"
        if (screenRecorded) details += "Экран записывается или транслируется"
        details += if (remote.installedApps.isEmpty()) "Известных программ не установлено"
        else "Установлено: ${remote.installedApps.joinToString()}"
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            details += "Запись экрана на этой версии Android не определяется"
        }
        remoteTile.show(
            alarm = active,
            state = if (active) "Телефоном могут управлять" else "Не обнаружен",
            detail = details.joinToString("\n"),
        )
        if (active != lastRemote) {
            lastRemote = active
            addLog(active, if (active) "Обнаружен удалённый доступ" else "Удалённого доступа нет", source)
        }
    }

    /** Новая запись встаёт в начало журнала: цветная точка, событие, время и источник. */
    private fun addLog(alarm: Boolean, title: String, note: String) {
        journalEmpty.visibility = View.GONE
        val row = LinearLayout(this).apply {
            setPadding(0, dp(9), 0, dp(9))
            addView(View(context).apply { background = dot(if (alarm) ALARM else CALM) },
                LinearLayout.LayoutParams(dp(10), dp(10)).apply { topMargin = dp(6); rightMargin = dp(12) })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(text(16f, INK, heavy = true).apply { text = title })
                addView(text(14f, MUTED).apply { text = "${time.format(Date())}, $note" })
            })
        }
        journal.addView(row, 0)
    }

    private fun showWarning() {
        TransferWarning.show(
            context = this,
            action = "warn",
            title = "Вы сейчас разговариваете по телефону",
            body = "Сотрудники банка, полиции и госорганов не просят переводить деньги на «безопасный счёт». " +
                "Если вас торопят с переводом — положите трубку.",
            onCancel = { addLog(false, "Предупреждение: перевод отменён", "кнопка") },
            onProceed = { addLog(true, "Предупреждение: клиент продолжил", "кнопка") },
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

    /** Плитка одного сигнала. Спокойное состояние — белая, сработавшее — сплошная красная. */
    private inner class SignalTile(title: String) {
        private val label = text(15f, MUTED).apply { text = title }
        private val state = text(26f, INK, heavy = true).apply { letterSpacing = -0.01f }
        private val detail = text(15f, MUTED).apply { setLineSpacing(dp(3).toFloat(), 1f) }
        private val chip = text(13f, Color.WHITE, heavy = true).apply {
            setPadding(dp(12), dp(5), dp(12), dp(5))
        }
        val view: LinearLayout = LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(20), dp(22), dp(22))
            elevation = dp(2).toFloat()
            addView(LinearLayout(context).apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(label, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                addView(chip)
            })
            addView(state, spaced(10))
            addView(detail, spaced(6))
        }

        fun show(alarm: Boolean, state: String, detail: String) {
            view.background = rounded(if (alarm) ALARM else SURFACE, 28)
            label.setTextColor(if (alarm) Color.argb(210, 255, 255, 255) else MUTED)
            this.state.text = state
            this.state.setTextColor(if (alarm) Color.WHITE else INK)
            this.detail.text = detail
            this.detail.setTextColor(if (alarm) Color.argb(225, 255, 255, 255) else MUTED)
            chip.text = if (alarm) "сработал" else "спокойно"
            chip.setTextColor(if (alarm) ALARM else CALM_INK)
            chip.background = rounded(if (alarm) Color.WHITE else CALM_BG, 100)
        }
    }

    private fun rounded(fill: Int, radius: Int) = GradientDrawable().apply {
        cornerRadius = dp(radius).toFloat()
        setColor(fill)
    }

    private fun dot(color: Int) = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(color)
    }

    private fun text(size: Float, color: Int, heavy: Boolean = false) = TextView(this).apply {
        textSize = size
        setTextColor(color)
        typeface = if (heavy) Typeface.create("sans-serif-medium", Typeface.BOLD) else Typeface.create("sans-serif", Typeface.NORMAL)
    }

    private fun button(label: String, onClick: () -> Unit) = TextView(this).apply {
        text = label
        textSize = 17f
        gravity = Gravity.CENTER
        typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
        setTextColor(Color.WHITE)
        minHeight = dp(58)
        background = rounded(ACCENT, 100)
        setOnClickListener { onClick() }
    }

    private fun topInset(insets: WindowInsets): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) insets.getInsets(WindowInsets.Type.systemBars()).top
        else @Suppress("DEPRECATION") insets.systemWindowInsetTop

    private fun bottomInset(insets: WindowInsets): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) insets.getInsets(WindowInsets.Type.systemBars()).bottom
        else @Suppress("DEPRECATION") insets.systemWindowInsetBottom

    private fun spaced(top: Int) = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(top) }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private companion object {
        val NAVY = Color.rgb(0x0B, 0x16, 0x38)
        val PAPER = Color.rgb(0xEE, 0xF1, 0xF6)
        val SURFACE = Color.WHITE
        val INK = Color.rgb(0x0E, 0x1B, 0x3D)
        val MUTED = Color.rgb(0x5C, 0x66, 0x80)
        val ACCENT = Color.rgb(0x2F, 0x5B, 0xFF)
        val CALM = Color.rgb(0x0B, 0x82, 0x50)
        val CALM_BG = Color.rgb(0xD8, 0xF4, 0xE6)
        val CALM_INK = Color.rgb(0x06, 0x60, 0x3A)
        val ALARM = Color.rgb(0xD3, 0x2B, 0x31)
    }
}
