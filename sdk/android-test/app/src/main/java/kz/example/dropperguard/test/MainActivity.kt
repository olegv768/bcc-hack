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
import android.os.SystemClock
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
 * Сигналы телефона клиента глазами фрод-мониторинга.
 * Модуль на этом телефоне раз в секунду проверяет звонок и удалённый доступ; экран показывает,
 * что дежурный сотрудник узнает о клиенте и что модуль отправит в сервис вместе с переводом.
 */
class MainActivity : Activity() {

    private val handler = Handler(Looper.getMainLooper())
    private val time = SimpleDateFormat("HH:mm:ss", Locale.US)

    private lateinit var verdict: LinearLayout
    private lateinit var verdictTitle: TextView
    private lateinit var verdictBody: TextView
    private lateinit var callRow: SignalRow
    private lateinit var remoteRow: SignalRow
    private lateinit var payload: TextView
    private lateinit var journal: LinearLayout
    private lateinit var journalEmpty: TextView

    private var lastOnCall: Boolean? = null
    private var lastRemote: Boolean? = null
    private var callStartedAt: Long? = null
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
            text = "Событий пока нет. Позвоните с этого телефона и вернитесь в приложение."
            setLineSpacing(dp(3).toFloat(), 1f)
        }

        // шапка: чей это телефон и откуда сведения
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(NAVY)
            setPadding(dp(SIDE), dp(26), dp(SIDE), dp(26))
            // на Android 15+ экран рисуется под строкой состояния: шапка уходит под неё, текст — ниже
            setOnApplyWindowInsetsListener { view, insets ->
                view.setPadding(dp(SIDE), dp(26) + topInset(insets), dp(SIDE), dp(26))
                insets
            }
            addView(text(15f, Color.argb(170, 255, 255, 255), weight = 500).apply { text = "Фрод-мониторинг" })
            addView(text(27f, Color.WHITE, weight = 600, display = true).apply {
                text = "Телефон клиента"
                setLineSpacing(0f, 1.08f)
            }, spaced(6))
            addView(text(15f, Color.argb(190, 255, 255, 255)).apply {
                text = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}, Android ${Build.VERSION.RELEASE}. " +
                    "Сведения обновляются каждую секунду, разрешений модуль не запрашивает."
                setLineSpacing(dp(4).toFloat(), 1f)
            }, spaced(10))
        }

        // итог для дежурного: есть ли признаки того, что клиента ведут мошенники
        verdictTitle = text(21f, Color.WHITE, weight = 600, display = true).apply { setLineSpacing(0f, 1.1f) }
        verdictBody = text(16f, Color.WHITE).apply { setLineSpacing(dp(4).toFloat(), 1f) }
        verdict = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(SIDE), dp(20), dp(SIDE), dp(22))
            addView(verdictTitle)
            addView(verdictBody, spaced(8))
        }

        payload = text(14f, INK).apply {
            typeface = Typeface.MONOSPACE
            setLineSpacing(dp(5).toFloat(), 1f)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = rounded(FIELD, 14)
        }

        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            setOnApplyWindowInsetsListener { view, insets ->
                view.setPadding(0, 0, 0, dp(32) + bottomInset(insets))
                insets
            }
            addView(verdict)
            addView(callRow.view)
            addView(divider())
            addView(remoteRow.view)
            addView(divider())

            addView(padded(heading("Что уйдёт в сервис с переводом")), spaced(30))
            addView(padded(text(15f, MUTED).apply {
                text = "Эти поля модуль добавляет к запросу перевода. По ним сервис решает, предупредить клиента или придержать перевод."
                setLineSpacing(dp(3).toFloat(), 1f)
            }), spaced(6))
            addView(padded(payload), spaced(12))

            addView(padded(LinearLayout(context).apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(heading("События"), LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                addView(text(16f, ACCENT, weight = 600).apply {
                    text = "Очистить"
                    setPadding(dp(12), dp(10), 0, dp(10))
                    setOnClickListener {
                        journal.removeAllViews()
                        journalEmpty.visibility = View.VISIBLE
                    }
                })
            }), spaced(30))
            addView(padded(journalEmpty), spaced(8))
            addView(padded(journal), spaced(6))

            addView(padded(outlineButton("Как клиент увидит предупреждение") { showWarning() }), spaced(12))
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
        val now = SystemClock.elapsedRealtime()
        val onCall = CallSignal.isOnCall(this)
        val mode = (getSystemService(Context.AUDIO_SERVICE) as AudioManager).mode

        if (onCall != lastOnCall) {
            if (onCall) {
                callStartedAt = now
                if (lastOnCall != null) addLog(true, "Клиент начал разговор", "${modeName(mode)}, $source")
                else addLog(true, "Клиент уже разговаривает", "${modeName(mode)}, $source")
            } else if (lastOnCall == true) {
                val length = callStartedAt?.let { duration(now - it) }
                addLog(false, "Разговор закончился", (length?.let { "длился $it, " } ?: "") + source)
                callStartedAt = null
            }
            lastOnCall = onCall
        }
        callRow.show(
            alarm = onCall,
            state = if (onCall) "Клиент разговаривает" else "Не разговаривает",
            detail = if (onCall) "Идёт ${duration(now - (callStartedAt ?: now))}. Режим звука: ${modeName(mode)}"
            else "Режим звука: ${modeName(mode)}",
        )

        val remote = RemoteAccessSignal.check(this)
        val active = remote.controlEnabled || screenRecorded
        val details = mutableListOf<String>()
        if (remote.controlEnabled) details += "Включена служба управления: ${remote.controlServices.joinToString()}"
        if (screenRecorded) details += "Экран записывается или транслируется"
        details += if (remote.installedApps.isEmpty()) "Известных программ удалённого доступа нет"
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
            if (active || lastRemote == true) {
                addLog(active, if (active) "Обнаружен удалённый доступ" else "Удалённый доступ отключён", source)
            }
            lastRemote = active
        }

        showVerdict(onCall, active)
        payload.text = "sender_on_call: $onCall\nremote_access_active: $active"
    }

    /** Итог для дежурного. Обещаем только то, что делает сервис: правила — в service/src/model.ts. */
    private fun showVerdict(onCall: Boolean, remote: Boolean) {
        val (title, body) = when {
            onCall && remote -> "Клиент на звонке, телефоном могут управлять" to
                "Типичная картина: мошенник ведёт клиента по телефону и управляет экраном. Перевод новому получателю " +
                "получит предупреждение, а на подозрительный счёт будет придержан."
            remote -> "Телефоном могут управлять удалённо" to
                "Перевод новому получателю получит предупреждение, а на подозрительный счёт будет придержан."
            onCall -> "Клиент на звонке" to
                "Перевод новому получателю сервис проверит строже: при подозрительном счёте или необычной сумме " +
                "клиент получит предупреждение."
            else -> "Признаков давления нет" to
                "Клиент не разговаривает и удалённого доступа нет. Сервис решает только по счёту получателя."
        }
        val alarm = onCall || remote
        verdict.setBackgroundColor(if (alarm) ALARM else CALM)
        verdictTitle.text = title
        verdictBody.text = body
        verdictBody.setTextColor(Color.argb(235, 255, 255, 255))
    }

    /** Новая запись встаёт в начало; точки записей соединены линией, как на шкале времени. */
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
            onCancel = { addLog(false, "Клиент отменил перевод", "после предупреждения") },
            onProceed = { addLog(true, "Клиент продолжил перевод", "после предупреждения") },
        )
    }

    private fun duration(ms: Long): String {
        val seconds = ms / 1000
        return "%d:%02d".format(seconds / 60, seconds % 60)
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

    /** Строка одного сигнала во всю ширину. Сработавший сигнал — красная полоса слева и красный текст. */
    private inner class SignalRow(title: String) {
        private val bar = View(this@MainActivity)
        private val label = text(15f, MUTED).apply { text = title }
        private val state = text(21f, INK, weight = 600, display = true).apply { setLineSpacing(0f, 1.1f) }
        private val detail = text(15f, MUTED).apply { setLineSpacing(dp(4).toFloat(), 1f) }
        private val chip = text(13f, Color.WHITE, weight = 600).apply { setPadding(dp(12), dp(5), dp(12), dp(5)) }
        val view: LinearLayout = LinearLayout(this@MainActivity).apply {
            addView(bar, LinearLayout.LayoutParams(dp(5), MATCH_PARENT))
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(SIDE - 5), dp(20), dp(SIDE), dp(22))
                addView(LinearLayout(context).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    addView(label, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                    addView(chip)
                })
                addView(state, spaced(10))
                addView(detail, spaced(6))
            }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        }

        fun show(alarm: Boolean, state: String, detail: String) {
            bar.setBackgroundColor(if (alarm) ALARM else Color.WHITE)
            view.setBackgroundColor(if (alarm) ALARM_BG else Color.WHITE)
            this.state.text = state
            this.state.setTextColor(if (alarm) ALARM_INK else INK)
            this.detail.text = detail
            chip.text = if (alarm) "сработал" else "спокойно"
            chip.setTextColor(if (alarm) Color.WHITE else CALM_INK)
            chip.background = rounded(if (alarm) ALARM else CALM_BG, 100)
        }
    }

    private fun heading(value: String) = text(21f, INK, weight = 700).apply { text = value }

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

    private fun rounded(fill: Int, radius: Int, stroke: Int? = null) = GradientDrawable().apply {
        cornerRadius = dp(radius).toFloat()
        setColor(fill)
        if (stroke != null) setStroke(dp(2), stroke)
    }

    private fun dot(color: Int) = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(color)
    }

    /**
     * Шрифты: Onest для текста, Unbounded для заголовков (лежат в assets/fonts; стенд теперь использует только Onest).
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

    private fun outlineButton(label: String, onClick: () -> Unit) = TextView(this).apply {
        text = label
        textSize = 16f
        gravity = Gravity.CENTER
        typeface = font(display = false, weight = 600)
        setTextColor(INK)
        minHeight = dp(54)
        background = rounded(Color.WHITE, 100, stroke = LINE)
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
        val FIELD = Color.rgb(0xF2, 0xF4, 0xF8)
        val ACCENT = Color.rgb(0x2F, 0x5B, 0xFF)
        val CALM = Color.rgb(0x0B, 0x82, 0x50)
        val CALM_BG = Color.rgb(0xD8, 0xF4, 0xE6)
        val CALM_INK = Color.rgb(0x06, 0x60, 0x3A)
        val ALARM = Color.rgb(0xD3, 0x2B, 0x31)
        val ALARM_BG = Color.rgb(0xFF, 0xF1, 0xF1)
        val ALARM_INK = Color.rgb(0x8F, 0x12, 0x16)
    }
}
