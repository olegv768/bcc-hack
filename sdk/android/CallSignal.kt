package kz.example.dropperguard

import android.content.Context
import android.media.AudioManager
import android.os.Build
import java.util.concurrent.Executor

/**
 * Признак «клиент сейчас на звонке» без разрешений.
 *
 * AudioManager.getMode() не требует READ_PHONE_STATE и ничего не добавляет в манифест.
 * Режим звука общий для устройства, поэтому виден и обычный звонок, и звонок в мессенджере.
 * Сам звонок, номер и собеседник приложению недоступны — только факт разговора.
 *
 * Использование на экране подтверждения перевода:
 *   val onCall = CallSignal.isOnCall(context)      // положить в запрос перевода как sender_on_call
 */
object CallSignal {

    fun isOnCall(context: Context): Boolean {
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        return isCallMode(audio.mode)
    }

    /**
     * Следит за началом и концом звонка, пока открыт экран перевода (Android 12+).
     * На более старых версиях слушателя нет — достаточно вызвать isOnCall() в момент подтверждения.
     * Возвращает функцию отписки; вызвать её в onStop().
     */
    fun watch(context: Context, executor: Executor, onChange: (Boolean) -> Unit): () -> Unit {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return {}
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val listener = AudioManager.OnModeChangedListener { mode -> onChange(isCallMode(mode)) }
        audio.addOnModeChangedListener(executor, listener)
        return { audio.removeOnModeChangedListener(listener) }
    }

    private fun isCallMode(mode: Int): Boolean {
        // обычный звонок по сотовой сети
        if (mode == AudioManager.MODE_IN_CALL) return true
        // звонок в мессенджере или другом приложении связи
        if (mode == AudioManager.MODE_IN_COMMUNICATION) return true
        // тот же разговор, но звук переведён на другое устройство (Android 13+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            (mode == AudioManager.MODE_CALL_REDIRECT || mode == AudioManager.MODE_COMMUNICATION_REDIRECT)
        ) return true
        return false
    }
}
