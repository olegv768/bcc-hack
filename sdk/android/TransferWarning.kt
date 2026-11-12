package kz.example.dropperguard

import android.app.AlertDialog
import android.content.Context

/**
 * Показывает предупреждение, которое вернул сервис оценки (поля action и client_message ответа).
 *
 *   warn — клиент может отменить перевод или продолжить;
 *   hold — перевод не уходит, клиент только закрывает окно.
 *
 * Здесь стандартный диалог, чтобы пример не зависел от библиотек; в приложении банка
 * его заменяют своим компонентом — тексты приходят с сервера.
 */
object TransferWarning {

    fun show(
        context: Context,
        action: String,
        title: String,
        body: String,
        onCancel: () -> Unit,
        onProceed: () -> Unit,
    ) {
        val dialog = AlertDialog.Builder(context)
            .setTitle(title)
            .setMessage(body)
            .setCancelable(false)

        if (action == "hold") {
            dialog.setPositiveButton("Понятно") { _, _ -> onCancel() }
        } else {
            dialog.setPositiveButton("Отменить перевод") { _, _ -> onCancel() }
            dialog.setNegativeButton("Всё равно перевести") { _, _ -> onProceed() }
        }
        dialog.show()
    }
}
