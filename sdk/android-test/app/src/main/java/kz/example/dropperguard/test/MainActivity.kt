package kz.example.dropperguard.test

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kz.example.dropperguard.CallSignal
import kz.example.dropperguard.TransferWarning
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Проверка модуля на настоящем телефоне: видит ли CallSignal обычный звонок и звонок в мессенджере.
 * Экран раз в секунду спрашивает CallSignal.isOnCall() и пишет в журнал каждое изменение.
 */
class MainActivity : Activity() {

    private val handler = Handler(Looper.getMainLooper())
    private val time = SimpleDateFormat("HH:mm:ss", Locale.US)
    private lateinit var status: TextView
    private lateinit var mode: TextView
    private lateinit var log: TextView
    private var lastOnCall: Boolean? = null
    private var stopWatching: () -> Unit = {}

    private val poll = object : Runnable {
        override fun run() {
            refresh("опрос")
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()

        status = TextView(this).apply {
            textSize = 30f
            setTypeface(typeface, Typeface.BOLD)
        }
        mode = TextView(this).apply { textSize = 15f }
        log = TextView(this).apply {
            textSize = 14f
            typeface = Typeface.MONOSPACE
        }

        val warn = Button(this).apply {
            text = "Показать предупреждение"
            setOnClickListener { showWarning() }
        }
        val clear = Button(this).apply {
            text = "Очистить журнал"
            setOnClickListener { log.text = "" }
        }

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            fitsSystemWindows = true
            addView(TextView(context).apply {
                text = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}), ${Build.MANUFACTURER} ${Build.MODEL}\n" +
                    "Разрешений у приложения нет."
                textSize = 14f
            })
            addView(status, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = pad })
            addView(mode)
            addView(warn, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = pad })
            addView(clear, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(TextView(context).apply {
                text = "Журнал изменений"
                textSize = 15f
                setTypeface(typeface, Typeface.BOLD)
            }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = pad })
            addView(log)
        }
        setContentView(ScrollView(this).apply { addView(content) })
    }

    override fun onStart() {
        super.onStart()
        handler.post(poll)
        // На Android 12+ дополнительно проверяем слушатель: он должен сработать сразу, без ожидания опроса.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            stopWatching = CallSignal.watch(this, mainExecutor) { refresh("слушатель") }
        }
    }

    override fun onStop() {
        super.onStop()
        handler.removeCallbacks(poll)
        stopWatching()
        stopWatching = {}
    }

    private fun refresh(source: String) {
        val onCall = CallSignal.isOnCall(this)
        val rawMode = (getSystemService(Context.AUDIO_SERVICE) as AudioManager).mode

        status.text = if (onCall) "На звонке: ДА" else "На звонке: НЕТ"
        status.setTextColor(if (onCall) Color.rgb(160, 30, 30) else Color.rgb(20, 100, 20))
        mode.text = "Режим звука: ${modeName(rawMode)} ($rawMode)"

        if (onCall != lastOnCall) {
            lastOnCall = onCall
            val line = "${time.format(Date())}  ${if (onCall) "ДА " else "НЕТ"}  ${modeName(rawMode)}  ($source)\n"
            log.text = line + log.text
        }
    }

    private fun showWarning() {
        TransferWarning.show(
            context = this,
            action = "warn",
            title = "Вы сейчас разговариваете по телефону",
            body = "Сотрудники банка, полиции и госорганов не просят переводить деньги на «безопасный счёт». " +
                "Если вас торопят с переводом — положите трубку.",
            onCancel = { log.text = "${time.format(Date())}  предупреждение: перевод отменён\n" + log.text },
            onProceed = { log.text = "${time.format(Date())}  предупреждение: клиент продолжил\n" + log.text },
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
        else -> "другой"
    }
}
