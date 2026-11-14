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
import android.view.WindowInsetsController
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

    private lateinit var callRow: SignalRow
    private lateinit var remoteRow: SignalRow
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
        window.navigationBarColor = Color.WHITE
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        // значки строки состояния — светлые: под ними тёмная шапка
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS)
        }

        callRow = SignalRow("Звонок")
        remoteRow = SignalRow("Удалённый доступ")
        journal = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        journalEmpty = text(16f, MUTED).apply {
            text = "Изменений пока не было. Позвоните кому-нибудь и вернитесь в приложение."
            setLineSpacing(dp(3).toFloat(), 1f)
        }

        // тёмная шапка: что это за экран и на каком телефоне идёт проверка
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(NAVY)
            setPadding(dp(SIDE), dp(30), dp(SIDE), dp(30))
            // на Android 15+ экран рисуется под строкой состояния: шапка уходит под неё, текст — ниже
            setOnApplyWindowInsetsListener { view, insets ->
                view.setPadding(dp(SIDE), dp(30) + topInset(insets), dp(SIDE), dp(30))
                insets
            }
            addView(text(29f, Color.WHITE, weight = 600, display = true).apply {
                text = "Что видит телефон"
                setLineSpacing(0f, 1.08f)
            })
            addView(text(16f, Color.argb(190, 255, 255, 255)).apply {
                text = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}, Android ${Build.VERSION.RELEASE}. " +
                    "Приложение не запрашивает ни одного разрешения."
                setLineSpacing(dp(4).toFloat(), 1f)
            }, spaced(12))
        }

        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            setOnApplyWindowInsetsListener { view, insets ->
                view.setPadding(0, 0, 0, dp(32) + bottomInset(insets))
                insets
            }
            // сигналы идут сплошными строками во всю ширину: сработавший закрашивается целиком
            addView(callRow.view)
            addView(divider())
            addView(remoteRow.view)
            addView(divider())

            addView(padded(button("Показать предупреждение клиенту") { showWarning() }), spaced(24))

            addView(padded(LinearLayout(context).apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(text(22f, INK, weight = 700).apply { text = "Журнал" }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                addView(text(16f, ACCENT, weight = 600).apply {
                    text = "Очистить"
                    setPadding(dp(12), dp(10), 0, dp(10))
                    setOnClickListener {
                        journal.removeAllViews()
                        journalEmpty.visibility = View.VISIBLE
                    }
                })
            }), spaced(36))
            addView(padded(journalEmpty), spaced(10))
            addView(padded(journal), spaced(6))
        }

        setContentView(ScrollView(this).apply {
            setBackgroundColor(Color.WHITE)
            isFillViewport = true
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(header)
                addView(body, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            })
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
        callRow.show(
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
        remoteRow.show(
            alarm = active,
            state = if (active) "Телефоном могут управлять" else "Не обнаружен",
            detail = details.joinToString("\n"),
        )
        if (active != lastRemote) {
            lastRemote = active
            addLog(active, if (active) "Обнаружен удалённый доступ" else "Удалённого доступа нет", source)
        }
    }

    /** Новая запись встаёт в начало журнала; точки записей соединены линией, как на шкале времени. */
    private fun addLog(alarm: Boolean, title: String, note: String) {
        journalEmpty.visibility = View.GONE
        val row = LinearLayout(this).apply {
            isBaselineAligned = false
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
                addView(View(context).apply { background = dot(if (alarm) ALARM else CALM) },
                    LinearLayout.LayoutParams(dp(12), dp(12)).apply { topMargin = dp(5) })
                addView(View(context).apply { setBackgroundColor(LINE) },
                    LinearLayout.LayoutParams(dp(2), 0, 1f).apply { topMargin = dp(5) })
            }, LinearLayout.LayoutParams(dp(12), MATCH_PARENT).apply { rightMargin = dp(14) })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, 0, 0, dp(20))
                addView(text(17f, INK, weight = 600).apply { text = title })
                addView(text(15f, MUTED).apply { text = "${time.format(Date())}, $note" }, spaced(2))
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

    /** Строка одного сигнала во всю ширину экрана. Спокойная — белая, сработавшая — сплошная красная. */
    private inner class SignalRow(title: String) {
        private val label = text(16f, MUTED).apply { text = title }
        private val state = text(23f, INK, weight = 600, display = true).apply { setLineSpacing(0f, 1.1f) }
        private val detail = text(16f, MUTED).apply { setLineSpacing(dp(4).toFloat(), 1f) }
        private val chip = text(14f, Color.WHITE, weight = 600).apply { setPadding(dp(13), dp(6), dp(13), dp(6)) }
        val view: LinearLayout = LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(SIDE), dp(24), dp(SIDE), dp(26))
            addView(LinearLayout(context).apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(label, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                addView(chip)
            })
            addView(state, spaced(12))
            addView(detail, spaced(8))
        }

        fun show(alarm: Boolean, state: String, detail: String) {
            view.setBackgroundColor(if (alarm) ALARM else Color.WHITE)
            label.setTextColor(if (alarm) Color.argb(215, 255, 255, 255) else MUTED)
            this.state.text = state
            this.state.setTextColor(if (alarm) Color.WHITE else INK)
            this.detail.text = detail
            this.detail.setTextColor(if (alarm) Color.argb(230, 255, 255, 255) else MUTED)
            chip.text = if (alarm) "сработал" else "спокойно"
            chip.setTextColor(if (alarm) ALARM else CALM_INK)
            chip.background = rounded(if (alarm) Color.WHITE else CALM_BG, 100)
        }
    }

    private fun divider() = View(this).apply {
        setBackgroundColor(LINE)
        layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, dp(1))
    }

    /** Оборачивает блок в боковые поля экрана. */
    private fun padded(child: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(SIDE), 0, dp(SIDE), 0)
        addView(child, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
    }

    private fun rounded(fill: Int, radius: Int) = GradientDrawable().apply {
        cornerRadius = dp(radius).toFloat()
        setColor(fill)
    }

    private fun dot(color: Int) = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(color)
    }

    /**
     * Шрифты те же, что на стенде: Onest для текста, Unbounded для заголовков (лежат в assets/fonts).
     * Насыщенность задаётся числом; на Android 7 переменные шрифты не поддерживаются — берём системный.
     */
    private fun font(display: Boolean, weight: Int): Typeface {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return Typeface.create("sans-serif", if (weight >= 600) Typeface.BOLD else Typeface.NORMAL)
        }
        return fonts.getOrPut(display to weight) {
            Typeface.Builder(assets, if (display) "fonts/Unbounded.ttf" else "fonts/Onest.ttf")
                .setFontVariationSettings("'wght' $weight")
                .build()
        }
    }

    private val fonts = HashMap<Pair<Boolean, Int>, Typeface>()

    private fun text(size: Float, color: Int, weight: Int = 400, display: Boolean = false) = TextView(this).apply {
        textSize = size
        setTextColor(color)
        typeface = font(display, weight)
        includeFontPadding = false
    }

    private fun button(label: String, onClick: () -> Unit) = TextView(this).apply {
        text = label
        textSize = 17f
        gravity = Gravity.CENTER
        typeface = font(display = false, weight = 600)
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
        const val SIDE = 22 // боковые поля экрана
        val NAVY = Color.rgb(0x0B, 0x16, 0x38)
        val INK = Color.rgb(0x0E, 0x1B, 0x3D)
        val MUTED = Color.rgb(0x5C, 0x66, 0x80)
        val LINE = Color.rgb(0xE1, 0xE5, 0xEE)
        val ACCENT = Color.rgb(0x2F, 0x5B, 0xFF)
        val CALM = Color.rgb(0x0B, 0x82, 0x50)
        val CALM_BG = Color.rgb(0xD8, 0xF4, 0xE6)
        val CALM_INK = Color.rgb(0x06, 0x60, 0x3A)
        val ALARM = Color.rgb(0xD3, 0x2B, 0x31)
    }
}
